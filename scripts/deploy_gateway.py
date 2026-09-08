"""Deploy one Linux/Docker Gateway and preserve its previous container for recovery."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from uuid import uuid4
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler, Request


class DeploymentError(Exception):
    pass


def readiness_probe(port, control_host):
    options = {"host": "127.0.0.1", "port": port, "path": "/health/ready",
               "headers": {"host": control_host}}
    # Node fetch can replace Host with the URL host. The Gateway routes by Host.
    return ("import http from 'node:http'; const request = http.get(" + json.dumps(options) +
            ", response => { response.resume(); process.exit(response.statusCode === 200 ? 0 : 1); });"
            "request.on('error', () => process.exit(1)); request.setTimeout(3000, () => request.destroy());")


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def read_private(path):
    require(path.is_file() and not path.is_symlink(), f"Missing regular file: {path.name}")
    require(path.stat().st_mode & 0o077 == 0, f"{path.name} must have mode 600 or 400")
    require(path.stat().st_size <= 65536, f"{path.name} is too large")
    return path.read_text()


def parse_env(source):
    values = {}
    for line in source.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        require(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key), "Use literal KEY=value environment lines")
        require(key not in values, f"Duplicate setting: {key}")
        values[key] = value
    return values


def validate_manifest(manifest):
    require(re.fullmatch(r"[a-z0-9_.-]+/[a-z0-9_.-]+", manifest.get("repository", "")), "Invalid repository")
    require(re.fullmatch(r"[a-f0-9]{40}", manifest.get("revision", "")), "Invalid source revision")
    require(re.fullmatch(r"[0-9]{1,20}", manifest.get("runId", "")), "Invalid run ID")
    for key in ("runNumber", "attempt"):
        require(type(manifest.get(key)) is int and manifest[key] > 0, f"Invalid {key}")
    require(re.fullmatch(r"[a-zA-Z0-9_-]+(?:\[bot\])?", manifest.get("registryUser", "")), "Invalid registry user")
    for target in ("gateway", "admin-cli", "canary-check"):
        prefix = f"ghcr.io/{manifest['repository']}-{target}@sha256:"
        image = manifest.get("images", {}).get(target, "")
        require(re.fullmatch(re.escape(prefix) + r"[a-f0-9]{64}", image), f"{target} image must be a repository digest")
    return f"{manifest['revision'][:12]}-{manifest['runId']}-{manifest['attempt']}"


def load_configuration(root, manifest):
    require(root.is_dir() and not root.is_symlink(), "Deployment root must already exist")
    require(root.stat().st_mode & 0o077 == 0, "Deployment root must have mode 700")
    config = json.loads((root / "deployment.json").read_text())
    require(config.get("repository") == manifest["repository"], "Release repository differs from server configuration")
    if "adoptContainerId" in config:
        require(re.fullmatch(r"[a-f0-9]{64}", config["adoptContainerId"]), "adoptContainerId must be an exact container ID")
    for key in ("containerName", "network"):
        require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}", config.get(key, "")), f"Invalid {key}")
    require(config["network"] not in ("host", "none"), "Use a Docker bridge network for the Gateway")
    if config.get("proxyNetwork") is not None:
        require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}", config["proxyNetwork"]), "Invalid proxyNetwork")
        require(config["proxyNetwork"] not in ("host", "none", config["network"]), "Use a separate proxy bridge network")
    port = config.get("port")
    require((type(port) is int and 1024 <= port <= 65535) or
            (port is None and config.get("proxyNetwork")), "Set a loopback port or a proxyNetwork")
    require(re.fullmatch(r"[a-z0-9._-]{1,64}", config.get("adminUsername", "")), "Invalid administrator username")
    require(re.fullmatch(r"[1-9][0-9]*[mg]", config.get("memory", "")), "Set a memory limit, for example 1g")
    require(type(config.get("cpus")) in (int, float) and 0.1 <= config["cpus"] <= 32, "Invalid CPU limit")
    require(type(config.get("healthTimeoutSeconds")) is int and 5 <= config["healthTimeoutSeconds"] <= 180, "Invalid health timeout")
    for key in ("controlUrl", "canaryUrl"):
        url = urlsplit(config.get(key, ""))
        require(url.scheme == "https" and url.hostname and not url.username and not url.password
                and url.path in ("", "/") and not url.query and not url.fragment, f"{key} must be an HTTPS origin")
    ingress = Path(config.get("ingressConfigPath", ""))
    require(ingress.is_absolute() and ingress.is_file(), "ingressConfigPath must identify the active ingress configuration")
    require(ingress.stat().st_size <= 1048576, "Ingress configuration is too large")
    texts = {name: read_private(root / name) for name in ("gateway.env", "admin.env", "migration.env")}
    values = {name: parse_env(source) for name, source in texts.items()}
    gateway, admin, migration = (values[name] for name in ("gateway.env", "admin.env", "migration.env"))
    for name, environment in values.items():
        require(bool(environment.get("DATABASE_URL")), f"DATABASE_URL is required in {name}")
    for key in ("AUTH_SESSION_HMAC_KEY", "CANARY_BEARER_TOKEN", "CONTENT_DOMAIN", "CONTROL_HOST", "CANARY_HOST"):
        require(bool(gateway.get(key)), f"{key} is required in gateway.env")
    require(admin.get("AUTH_SESSION_HMAC_KEY") == gateway["AUTH_SESSION_HMAC_KEY"], "Admin and Gateway must use the same session key")
    require(gateway.get("ALLOW_INSECURE_HTTP_AUTH", "false") == "false", "Production cookies must require HTTPS")
    require(gateway["CONTROL_HOST"] == urlsplit(config["controlUrl"]).hostname, "Control origin does not match gateway.env")
    require(gateway["CANARY_HOST"] == urlsplit(config["canaryUrl"]).hostname, "Canary origin does not match gateway.env")
    # Different database roles are expected; every role must address the same database.
    destinations = [(urlsplit(env["DATABASE_URL"]).hostname, urlsplit(env["DATABASE_URL"]).port or 5432,
                     urlsplit(env["DATABASE_URL"]).path) for env in (gateway, admin, migration)]
    require(len(set(destinations)) == 1, "Gateway, admin and migration must address the same database")
    password = read_private(root / "admin-password").removesuffix("\n")
    require(password and "\n" not in password and "\r" not in password, "Admin password file must contain one line")
    digest = hashlib.sha256()
    for value in [json.dumps(manifest["images"], sort_keys=True), json.dumps(config, sort_keys=True),
                  texts["gateway.env"], ingress.read_text()]:
        encoded = value.encode()
        digest.update(len(encoded).to_bytes(8, "big") + encoded)
    return config, gateway, password + "\n", "sha256:" + digest.hexdigest()


class Docker:
    def __init__(self, config_directory):
        self.prefix = ["docker", "--config", str(config_directory)]

    def run(self, arguments, *, input_text=None, check=True, timeout=180):
        temporary_container = None
        if arguments[0] == "run" and "--rm" in arguments:
            temporary_container = "lotur-deploy-job-" + uuid4().hex
            arguments = ["run", "--name", temporary_container, *arguments[1:]]
        try:
            result = subprocess.run(self.prefix + arguments, input=input_text, text=True,
                                    capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise DeploymentError(f"Docker {arguments[0]} timed out") from None
        finally:
            if temporary_container:
                # Killing a Docker CLI alone does not reliably stop its daemon-side job.
                try:
                    subprocess.run(self.prefix + ["rm", "--force", temporary_container],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        if check and result.returncode != 0:
            # Docker/DB errors can contain runtime settings. Keep them out of CI logs.
            raise DeploymentError(f"Docker {arguments[0]} failed (exit {result.returncode})")
        return result

    def inspect(self, name):
        result = self.run(["container", "inspect", name], check=False)
        if result.returncode:
            # Distinguish an absent container from an unavailable daemon.
            self.run(["info", "--format", "{{.ServerVersion}}"])
            require("No such" in result.stderr, "Container inspection failed")
            return None
        return json.loads(result.stdout)[0]


class Deployment:
    def __init__(self, root, manifest, docker):
        self.root, self.manifest, self.docker = root, manifest, docker
        self.release_id = validate_manifest(manifest)
        self.config, self.gateway, self.password, self.digest = load_configuration(root, manifest)
        self.name = self.config["containerName"]
        self.previous = None

    def admin(self, command, extra=()):
        result = self.docker.run([
            "run", "--rm", "-i", "--network", self.config["network"],
            "--env-file", str(self.root / "admin.env"),
            self.manifest["images"]["admin-cli"], command,
            "--as", self.config["adminUsername"], "--deployment-id", self.release_id,
            "--config-digest", self.digest, "--password-stdin", *extra,
        ], input_text=self.password)
        return json.loads(result.stdout)

    def previous_address(self):
        settings = dict(item.split("=", 1) for item in self.previous["Config"].get("Env", []))
        port = settings.get("GATEWAY_PORT", "8787")
        require(port.isdigit() and 1 <= int(port) <= 65535 and settings.get("CONTROL_HOST"),
                "Existing Gateway must set CONTROL_HOST and a valid internal port")
        return int(port), settings["CONTROL_HOST"]

    def ready(self, previous=False):
        port, host = self.previous_address() if previous else (8787, self.gateway["CONTROL_HOST"])
        # Check the exact container, including installations that publish no host port.
        probe = readiness_probe(port, host)
        deadline = time.monotonic() + self.config["healthTimeoutSeconds"]
        while True:
            result = self.docker.run(["exec", self.name, "node", "--input-type=module", "-e", probe],
                                     check=False, timeout=10)
            if result.returncode == 0:
                return
            if time.monotonic() >= deadline:
                raise DeploymentError("Gateway readiness check failed")
            time.sleep(1)

    def public_canary(self):
        request = Request(self.config["controlUrl"].rstrip("/") + "/health/ready")
        deadline = time.monotonic() + self.config["healthTimeoutSeconds"]
        while True:
            try:
                with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
                    require(response.url == request.full_url, "Public Control redirected unexpectedly")
                    if response.status == 200:
                        break
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise DeploymentError("Public Control readiness check failed")
            # Docker DNS caches in an existing ingress can outlive the old container.
            time.sleep(1)
        with tempfile.TemporaryDirectory(prefix="lotur-canary-") as directory:
            environment = Path(directory) / "canary.env"
            environment.write_text("CANARY_BEARER_TOKEN=" + self.gateway["CANARY_BEARER_TOKEN"] + "\n")
            environment.chmod(0o600)
            self.docker.run([
                "run", "--rm", "--network", self.config.get("proxyNetwork") or self.config["network"],
                "--env-file", str(environment),
                "--env", f"CANARY_CONTENT_URL={self.config['canaryUrl']}",
                "--env", "ALLOW_INSECURE_CANARY=false",
                self.manifest["images"]["canary-check"],
            ], timeout=90)

    def execute(self):
        state_path = self.root / "current-release.json"
        if state_path.exists():
            current = json.loads(state_path.read_text())
            require(self.manifest["runNumber"] >= current["runNumber"], "A newer workflow has already deployed")
        self.docker.run(["network", "inspect", self.config["network"]])
        if self.config.get("proxyNetwork"):
            self.docker.run(["network", "inspect", self.config["proxyNetwork"]])
        self.previous = self.docker.inspect(self.name)
        if self.previous:
            labels = self.previous["Config"].get("Labels") or {}
            require(labels.get("io.review-tunnel.managed") == self.manifest["repository"] or
                    self.previous["Id"] == self.config.get("adoptContainerId"),
                    "Existing container is not managed by this deployment; migrate it explicitly first")
            self.previous_address()
        for image in self.manifest["images"].values():
            self.docker.run(["pull", image], timeout=300)
            metadata = json.loads(self.docker.run(["image", "inspect", image]).stdout)[0]
            require(metadata["Config"]["Labels"].get("org.opencontainers.image.revision") == self.manifest["revision"],
                    "Image source revision differs from the release")
        print("Images downloaded; validating configuration and administrator access.", flush=True)
        self.docker.run([
            "run", "--rm", "--env-file", str(self.root / "gateway.env"),
            "--env", "GATEWAY_HOST=0.0.0.0", "--env", "GATEWAY_PORT=8787",
            "--env", "AUTO_MIGRATE=false", "--env", f"DEPLOYMENT_ID={self.release_id}",
            "--env", f"DEPLOYMENT_CONFIG_DIGEST={self.digest}",
            "--entrypoint", "node", self.manifest["images"]["gateway"],
            "--input-type=module", "-e",
            "import {readGatewayConfig} from './dist/apps/gateway/src/config.js'; readGatewayConfig(process.env);",
        ])
        # Authenticate and inspect the kill switch before changing the running Gateway.
        status = self.admin("admission-status")
        require(status.get("killSwitchEnabled") is False, "Deployment paused: the sharing kill switch is enabled")
        print("Applying database migrations before replacing the Gateway.", flush=True)
        self.docker.run(["run", "--rm", "--network", self.config["network"],
                         "--env-file", str(self.root / "migration.env"),
                         self.manifest["images"]["admin-cli"], "migrate"])
        backup = f"{self.name}-previous-{self.release_id}"
        try:
            print("Starting the new Gateway; the previous container will be retained.", flush=True)
            if self.previous:
                if self.previous["State"]["Running"]:
                    self.docker.run(["stop", "--time", "35", self.name])
                self.docker.run(["rename", self.name, backup])
            networking = ["--network", self.config["network"]]
            if self.config.get("proxyNetwork"):
                networking += ["--network", self.config["proxyNetwork"]]
            if self.config.get("port") is not None:
                networking += ["--publish", f"127.0.0.1:{self.config['port']}:8787"]
            self.docker.run([
                "run", "--detach", "--init", "--name", self.name,
                "--label", f"io.review-tunnel.managed={self.manifest['repository']}",
                "--label", f"org.opencontainers.image.revision={self.manifest['revision']}",
                *networking, "--restart", "unless-stopped",
                "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
                "--memory", self.config["memory"], "--cpus", str(self.config["cpus"]),
                "--pids-limit", "256", "--stop-timeout", "35",
                "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
                "--env-file", str(self.root / "gateway.env"),
                "--env", "GATEWAY_HOST=0.0.0.0", "--env", "GATEWAY_PORT=8787",
                "--env", "AUTO_MIGRATE=false", "--env", f"DEPLOYMENT_ID={self.release_id}",
                "--env", f"DEPLOYMENT_CONFIG_DIGEST={self.digest}",
                self.manifest["images"]["gateway"],
            ])
            self.ready()
            print("Checking the public HTTPS, streaming and WebSocket path.", flush=True)
            self.public_canary()
            self.admin("record-canary", ["--result", "passed"])
            self.admin("approve-admission")
            status = self.admin("admission-status")
            require(status.get("admissionReady") is True, "Gateway admission did not open")
            self.ready()
            state = {**self.manifest, "deploymentId": self.release_id, "configDigest": self.digest,
                     "previousContainer": backup if self.previous else None}
            temporary = self.root / "current-release.json.tmp"
            temporary.write_text(json.dumps(state, indent=2) + "\n")
            temporary.chmod(0o600)
            temporary.replace(state_path)
        except (Exception, KeyboardInterrupt) as error:
            try:
                self.recover()
            except Exception:
                raise DeploymentError("Deployment failed and automatic recovery failed; inspect the server") from error
            raise DeploymentError("Deployment failed; previous container restored" if self.previous
                                  else "First deployment failed; the failed Gateway was stopped") from error
        print(f"Deployment verified: {self.release_id}", flush=True)

    def recover(self):
        # A failed docker run may still have created a container before returning nonzero.
        candidate = self.docker.inspect(self.name)
        candidate_is_new = candidate and (not self.previous or candidate["Id"] != self.previous["Id"])
        if candidate_is_new:
            require((candidate["Config"].get("Labels") or {}).get("io.review-tunnel.managed") == self.manifest["repository"],
                    "Refusing to stop an unrelated container during recovery")
            try:
                self.admin("record-canary", ["--result", "failed"])
            except Exception:
                pass
            self.docker.run(["stop", "--time", "35", self.name])
            self.docker.run(["rename", self.name, f"{self.name}-failed-{self.release_id}"])
        if self.previous:
            previous_now = self.docker.inspect(self.previous["Id"])
            require(previous_now is not None, "The previous container is missing")
            if previous_now["Name"] != "/" + self.name:
                self.docker.run(["rename", self.previous["Id"], self.name])
            if self.previous["State"]["Running"]:
                self.docker.run(["start", self.name])
                self.ready(previous=True)
        # Never reverse migrations or change the global emergency switch.


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(arguments)
    os.umask(0o077)
    manifest = json.loads(args.manifest.read_text())
    validate_manifest(manifest)
    require(args.root.is_dir() and not args.root.is_symlink(), "Deployment root must already exist")
    require(args.root.stat().st_mode & 0o077 == 0, "Deployment root must have mode 700")
    with (args.root / ".deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError("Another deployment is running") from None
        with tempfile.TemporaryDirectory(prefix="lotur-registry-") as temporary:
            docker = Docker(temporary)
            deployment = Deployment(args.root, manifest, docker)
            token = sys.stdin.readline(16384).strip()
            require(bool(token), "Registry token is required on stdin")
            docker.run(["login", "ghcr.io", "--username", manifest["registryUser"], "--password-stdin"], input_text=token)
            # SSH disconnects and normal job cancellation enter the same recovery path.
            def interrupted(_number, _frame):
                raise KeyboardInterrupt()
            for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
                signal.signal(number, interrupted)
            deployment.execute()


if __name__ == "__main__":
    try:
        main()
    except (DeploymentError, ValueError, OSError, KeyboardInterrupt) as error:
        print(f"Deployment error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
