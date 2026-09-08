"""Transfer a release to the configured Linux host; never transfer database secrets."""

import json
import os
from pathlib import Path
import re
import hashlib
import subprocess
import tempfile


def required(environment, name):
    value = environment.get(name, "")
    if not value:
        raise ValueError(f"{name} is required")
    return value


def connection(environment, key, known_hosts):
    host = required(environment, "DEPLOY_HOST")
    user = required(environment, "DEPLOY_USER")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", host):
        raise ValueError("DEPLOY_HOST must be a DNS hostname or IPv4 address")
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_-]*", user):
        raise ValueError("DEPLOY_USER is invalid")
    port = int(environment.get("DEPLOY_PORT", "22"))
    if not 1 <= port <= 65535:
        raise ValueError("DEPLOY_PORT is invalid")
    options = ["-i", str(key), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
               "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
               "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
               "-o", "ServerAliveCountMax=4"]
    return ["ssh", "-T", *options, "-p", str(port)], f"{user}@{host}"


def run(environment=os.environ):
    manifest = {
        "repository": required(environment, "GITHUB_REPOSITORY").lower(),
        "revision": required(environment, "GITHUB_SHA"),
        "runId": required(environment, "GITHUB_RUN_ID"),
        "runNumber": int(required(environment, "GITHUB_RUN_NUMBER")),
        "attempt": int(environment.get("GITHUB_RUN_ATTEMPT", "1")),
        "registryUser": required(environment, "REGISTRY_USER"),
        "images": {"gateway": required(environment, "GATEWAY_IMAGE"),
                   "admin-cli": required(environment, "ADMIN_IMAGE"),
                   "canary-check": required(environment, "CANARY_IMAGE")},
        "workerDigest": hashlib.sha256(Path(__file__).with_name("deploy_gateway.py").read_bytes()).hexdigest(),
    }
    token = required(environment, "REGISTRY_TOKEN")
    if "\n" in token or "\r" in token:
        raise ValueError("REGISTRY_TOKEN must be one line")
    with tempfile.TemporaryDirectory(prefix="lotur-ssh-") as directory:
        directory = Path(directory)
        key, known_hosts = directory / "key", directory / "known_hosts"
        key.write_text(required(environment, "DEPLOY_SSH_KEY").rstrip("\n") + "\n")
        known_hosts.write_text(required(environment, "DEPLOY_KNOWN_HOSTS").rstrip("\n") + "\n")
        key.chmod(0o600)
        known_hosts.chmod(0o600)
        ssh, target = connection(environment, key, known_hosts)
        # The key is forced to the installed receiver: it cannot open a shell or upload code.
        subprocess.run([*ssh, target, "deploy"], input=json.dumps(manifest) + "\n" + token + "\n",
                       text=True, check=True)
    summary = environment.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as output:
            output.write(f"Deployed `{manifest['revision']}`; readiness, public canary and admission verified.\n")


if __name__ == "__main__":
    try:
        run()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Subprocess arguments never include passwords or the registry token.
        raise SystemExit(str(error)) from None
