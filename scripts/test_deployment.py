"""Failure-path tests for deployment orchestration; no production Docker or SSH calls."""

import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import deploy_gateway as deployment

spec = importlib.util.spec_from_file_location("deploy_ssh", Path(__file__).with_name("deploy-over-ssh.py"))
ssh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ssh)
receiver_spec = importlib.util.spec_from_file_location("receive_deployment", Path(__file__).with_name("receive-deployment.py"))
receiver = importlib.util.module_from_spec(receiver_spec)
receiver_spec.loader.exec_module(receiver)


def release():
    return {
        "repository": "example/lotur", "revision": "a" * 40, "runId": "100", "runNumber": 10,
        "attempt": 1, "registryUser": "example",
        "images": {target: f"ghcr.io/example/lotur-{target}@sha256:" + "b" * 64
                   for target in ("gateway", "admin-cli", "canary-check")},
    }


def container(identifier, name="gateway", running=True):
    return {"Id": identifier, "Name": "/" + name, "State": {"Running": running},
            "Config": {"Labels": {"io.review-tunnel.managed": "example/lotur"},
                       "Env": ["CONTROL_HOST=control.example.com"]},
            "HostConfig": {"PortBindings": {"8787/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8787"}]}}}


class FakeDocker:
    def __init__(self):
        self.containers = {"old": container("old")}
        self.commands = []
        self.fail_migration = False
        self.fail_start = False
        self.fail_approval = False
        self.fail_rename_after_change = False
        self.kill_switch = False

    def inspect(self, name):
        found = next((value for value in self.containers.values()
                      if value["Id"] == name or value["Name"] == "/" + name), None)
        return copy.deepcopy(found)

    def run(self, arguments, **_options):
        self.commands.append(arguments)
        if arguments[:2] == ["image", "inspect"]:
            return SimpleNamespace(stdout=json.dumps([{"Config": {"Labels": {
                "org.opencontainers.image.revision": "a" * 40}}}]))
        if arguments[0] == "run" and "--detach" in arguments:
            self.containers["new"] = container("new")
            if self.fail_start:
                raise deployment.DeploymentError("start failed after container creation")
        elif arguments[0] in ("stop", "start", "rename"):
            name = arguments[-2] if arguments[0] == "rename" else arguments[-1]
            item = self.containers[self.inspect(name)["Id"]]
            if arguments[0] == "rename":
                item["Name"] = "/" + arguments[-1]
                if self.fail_rename_after_change and item["Id"] == "old":
                    self.fail_rename_after_change = False
                    raise deployment.DeploymentError("rename response lost")
            else:
                item["State"]["Running"] = arguments[0] == "start"
        elif "migrate" in arguments and self.fail_migration:
            raise deployment.DeploymentError("migration failed")
        elif "approve-admission" in arguments and self.fail_approval:
            raise deployment.DeploymentError("approval failed")
        return SimpleNamespace(returncode=0, stdout=json.dumps({"killSwitchEnabled": self.kill_switch, "admissionReady": True}))


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lotur-deploy-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "ingress.conf").write_text("proxy to 127.0.0.1:8787")
        self.config = {
            "repository": "example/lotur", "containerName": "gateway", "network": "review-tunnel",
            "port": 8787, "adminUsername": "deploy-admin", "memory": "1g", "cpus": 1,
            "healthTimeoutSeconds": 5, "controlUrl": "https://control.example.com",
            "canaryUrl": "https://canary.preview.example.com",
            "ingressConfigPath": str(self.root / "ingress.conf"),
        }
        self.write_config()
        self.private("gateway.env", "DATABASE_URL=postgres://gateway:pass@db:5432/reviews\n"
                     "AUTH_SESSION_HMAC_KEY=test-key\nCANARY_BEARER_TOKEN=test-token\n"
                     "CONTROL_HOST=control.example.com\nCANARY_HOST=canary.preview.example.com\n"
                     "CONTENT_DOMAIN=preview.example.com\n")
        self.private("admin.env", "DATABASE_URL=postgres://admin:pass@db:5432/reviews\nAUTH_SESSION_HMAC_KEY=test-key\n")
        self.private("migration.env", "DATABASE_URL=postgres://ddl:pass@db:5432/reviews\n")
        self.private("admin-password", "test-only-administrator-password\n")
        self.docker = FakeDocker()
        self.subject = deployment.Deployment(self.root, release(), self.docker)
        self.readiness = []
        self.subject.ready = lambda previous=False: self.readiness.append(previous)
        self.subject.public_canary = lambda: None

    def private(self, name, content):
        path = self.root / name
        path.write_text(content)
        path.chmod(0o600)

    def write_config(self):
        (self.root / "deployment.json").write_text(json.dumps(self.config))

    def fail_canary(self):
        raise deployment.DeploymentError("public canary failed")

    def assert_old_running(self):
        self.assertEqual(self.docker.inspect("gateway")["Id"], "old")
        self.assertTrue(self.docker.inspect("gateway")["State"]["Running"])

    def test_success_records_the_release_and_preserves_previous_container(self):
        self.subject.execute()
        self.assertEqual(self.docker.inspect("gateway")["Id"], "new")
        self.assertFalse(self.docker.inspect("old")["State"]["Running"])
        state = json.loads((self.root / "current-release.json").read_text())
        self.assertEqual(state["revision"], "a" * 40)
        operations = [part for command in self.docker.commands for part in command]
        self.assertLess(operations.index("migrate"), operations.index("stop"))
        self.assertLess(operations.index("record-canary"), operations.index("approve-admission"))
        self.assertEqual(self.readiness, [False, False])

    def test_migration_failure_does_not_stop_the_existing_gateway(self):
        self.docker.fail_migration = True
        with self.assertRaisesRegex(deployment.DeploymentError, "migration"):
            self.subject.execute()
        self.assert_old_running()
        self.assertFalse(any(command[0] == "stop" for command in self.docker.commands))

    def test_private_database_and_docker_proxy_need_no_published_host_port(self):
        self.config.update(port=None, proxyNetwork="edge-proxy")
        self.write_config()
        self.docker.containers["old"]["HostConfig"]["PortBindings"] = {}
        subject = deployment.Deployment(self.root, release(), self.docker)
        subject.public_canary = lambda: None
        subject.execute()
        launch = next(command for command in self.docker.commands if "--detach" in command)
        self.assertNotIn("--publish", launch)
        self.assertEqual([launch[index + 1] for index, arg in enumerate(launch) if arg == "--network"],
                         ["review-tunnel", "edge-proxy"])
        self.assertEqual(sum(command[:2] == ["exec", "gateway"] for command in self.docker.commands), 2)

    def test_unpublished_previous_gateway_is_probed_on_its_original_internal_port_after_recovery(self):
        self.config.update(port=None, proxyNetwork="edge-proxy")
        self.write_config()
        self.docker.containers["old"]["HostConfig"]["PortBindings"] = {}
        self.docker.containers["old"]["Config"]["Env"].append("GATEWAY_PORT=9090")
        subject = deployment.Deployment(self.root, release(), self.docker)
        subject.public_canary = self.fail_canary
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            subject.execute()
        self.assert_old_running()
        probes = [command for command in self.docker.commands if command[0] == "exec"]
        self.assertIn("127.0.0.1:8787", probes[0][-1])
        self.assertIn("127.0.0.1:9090", probes[-1][-1])

    def test_public_canary_has_egress_without_database_network_access(self):
        self.config.update(port=None, proxyNetwork="edge-proxy")
        self.write_config()
        subject = deployment.Deployment(self.root, release(), self.docker)
        response = SimpleNamespace(status=200, url=self.config["controlUrl"] + "/health/ready")
        from contextlib import nullcontext
        opener = SimpleNamespace(open=lambda *_args, **_kwargs: nullcontext(response))
        with patch.object(deployment, "build_opener", return_value=opener):
            subject.public_canary()
        command = self.docker.commands[-1]
        self.assertEqual(command[command.index("--network") + 1], "edge-proxy")
        self.assertNotIn("review-tunnel", command)

    def test_start_failure_after_creation_restores_original(self):
        self.docker.fail_start = True
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            self.subject.execute()
        self.assert_old_running()
        self.assertFalse(self.docker.inspect("new")["State"]["Running"])

    def test_canary_failure_records_failure_and_restores_original(self):
        self.subject.public_canary = self.fail_canary
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            self.subject.execute()
        self.assert_old_running()
        self.assertTrue(any("failed" in command and "record-canary" in command for command in self.docker.commands))
        self.assertFalse(any("approve-admission" in command for command in self.docker.commands))
        self.assertFalse((self.root / "current-release.json").exists())
        self.assertEqual(self.readiness, [False, True])

    def test_approval_failure_restores_original(self):
        self.docker.fail_approval = True
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            self.subject.execute()
        self.assert_old_running()

    def test_local_readiness_failure_restores_original(self):
        def ready(previous=False):
            if not previous:
                raise deployment.DeploymentError("readiness failed")
        self.subject.ready = ready
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            self.subject.execute()
        self.assert_old_running()
        self.assertFalse(any("approve-admission" in command for command in self.docker.commands))

    def test_interrupted_rollout_restores_original(self):
        def interrupted():
            raise KeyboardInterrupt()
        self.subject.public_canary = interrupted
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            self.subject.execute()
        self.assert_old_running()

    def test_unhealthy_previous_container_reports_recovery_failure(self):
        self.subject.public_canary = self.fail_canary
        def ready(previous=False):
            if previous:
                raise deployment.DeploymentError("previous version is incompatible")
        self.subject.ready = ready
        with self.assertRaisesRegex(deployment.DeploymentError, "automatic recovery failed"):
            self.subject.execute()
        self.assertFalse((self.root / "current-release.json").exists())

    def test_rename_lost_ack_restores_by_container_id(self):
        self.docker.fail_rename_after_change = True
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            self.subject.execute()
        self.assert_old_running()

    def test_first_deployment_failure_stops_the_candidate(self):
        self.docker.containers.clear()
        self.subject.public_canary = self.fail_canary
        with self.assertRaisesRegex(deployment.DeploymentError, "First deployment failed"):
            self.subject.execute()
        self.assertIsNone(self.docker.inspect("gateway"))
        self.assertFalse(self.docker.inspect("new")["State"]["Running"])

    def test_emergency_switch_is_preserved_without_migrating_or_stopping(self):
        self.docker.kill_switch = True
        with self.assertRaisesRegex(deployment.DeploymentError, "kill switch"):
            self.subject.execute()
        self.assert_old_running()
        self.assertFalse(any("migrate" in command or command[0] == "stop" for command in self.docker.commands))

    def test_unrelated_container_is_not_adopted(self):
        self.docker.containers["old"]["Config"]["Labels"] = {}
        with self.assertRaisesRegex(deployment.DeploymentError, "not managed"):
            self.subject.execute()
        self.assert_old_running()
        self.assertFalse(any(command[0] in ("pull", "stop") for command in self.docker.commands))

    def test_explicit_first_adoption_is_bound_to_the_exact_container_id(self):
        identifier = "c" * 64
        old = self.docker.containers.pop("old")
        old["Id"] = identifier
        old["Config"]["Labels"] = {}
        self.docker.containers[identifier] = old
        self.config["adoptContainerId"] = "d" * 64
        self.write_config()
        self.subject = deployment.Deployment(self.root, release(), self.docker)
        self.subject.ready = lambda previous=False: None
        self.subject.public_canary = lambda: None
        with self.assertRaisesRegex(deployment.DeploymentError, "not managed"):
            self.subject.execute()
        self.config["adoptContainerId"] = identifier
        self.write_config()
        self.subject = deployment.Deployment(self.root, release(), self.docker)
        self.subject.ready = lambda previous=False: None
        self.subject.public_canary = lambda: None
        self.subject.execute()
        self.assertEqual(self.docker.inspect("gateway")["Id"], "new")

    def test_older_workflow_cannot_replace_a_newer_release(self):
        (self.root / "current-release.json").write_text(json.dumps({"runNumber": 11}))
        with self.assertRaisesRegex(deployment.DeploymentError, "newer workflow"):
            self.subject.execute()
        self.assertEqual(self.docker.commands, [])

    def test_mutable_or_foreign_images_are_rejected(self):
        for image in ("ghcr.io/example/lotur-gateway:latest", "ghcr.io/other/lotur-gateway@sha256:" + "b" * 64):
            manifest = release()
            manifest["images"]["gateway"] = image
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_manifest(manifest)

    def test_runtime_and_ingress_changes_change_the_deployment_identity(self):
        first = self.subject.digest
        (self.root / "ingress.conf").write_text("updated proxy configuration")
        second = deployment.load_configuration(self.root, release())[3]
        self.assertNotEqual(first, second)
        with (self.root / "gateway.env").open("a") as output:
            output.write("REVIEW_WORKFLOW_ENABLED=true\n")
        self.assertNotEqual(second, deployment.load_configuration(self.root, release())[3])

    def test_mismatched_database_and_readable_secrets_are_rejected(self):
        self.private("migration.env", "DATABASE_URL=postgres://ddl:pass@another-db:5432/reviews\n")
        with self.assertRaisesRegex(deployment.DeploymentError, "same database"):
            deployment.load_configuration(self.root, release())
        self.private("migration.env", "DATABASE_URL=postgres://ddl:pass@db:5432/reviews\n")
        (self.root / "admin-password").chmod(0o644)
        with self.assertRaisesRegex(deployment.DeploymentError, "mode 600"):
            deployment.load_configuration(self.root, release())

    def test_ssh_pins_host_keys_and_rejects_shell_fragments(self):
        environment = {"DEPLOY_HOST": "deploy.example.com", "DEPLOY_USER": "deployer", "DEPLOY_PORT": "2222"}
        command, target = ssh.connection(environment, "/key", "/known_hosts")
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("UserKnownHostsFile=/known_hosts", command)
        self.assertIn("2222", command)
        self.assertEqual(target, "deployer@deploy.example.com")
        for key, value in (("DEPLOY_HOST", "host;false"), ("DEPLOY_USER", "-oProxyCommand=bad"), ("DEPLOY_PORT", "0")):
            with self.assertRaises(ValueError):
                ssh.connection({**environment, key: value}, "/key", "/known_hosts")

    def test_receiver_rejects_shell_uploads_and_unreviewed_worker_changes(self):
        manifest = release()
        manifest["workerDigest"] = hashlib.sha256(Path(deployment.__file__).read_bytes()).hexdigest()
        with patch.object(deployment, "main") as main:
            for command in ("bash", "scp -t /tmp/file", "deploy; id", ""):
                with self.assertRaisesRegex(deployment.DeploymentError, "Only the deploy"):
                    receiver.receive(self.root, io.StringIO(json.dumps(manifest) + "\n"), command)
            with self.assertRaisesRegex(deployment.DeploymentError, "worker changed"):
                receiver.receive(self.root, io.StringIO(json.dumps({**manifest, "workerDigest": "0" * 64}) + "\n"), "deploy")
            main.assert_not_called()
            receiver.receive(self.root, io.StringIO(json.dumps(manifest) + "\n"), "deploy")
            main.assert_called_once()

    def test_timed_out_one_off_container_is_stopped_and_secret_stays_on_stdin(self):
        calls = []
        def command(arguments, **options):
            calls.append((arguments, options))
            if "run" in arguments:
                raise subprocess.TimeoutExpired(arguments, 1)
            return SimpleNamespace(returncode=0)
        with patch.object(deployment.subprocess, "run", command):
            with self.assertRaisesRegex(deployment.DeploymentError, "timed out"):
                deployment.Docker("/private-registry").run(
                    ["run", "--rm", "-i", "admin-image", "migrate"], input_text="private-test-secret", timeout=1)
        self.assertEqual(len(calls), 2)
        run_args = calls[0][0]
        name = run_args[run_args.index("--name") + 1]
        self.assertEqual(calls[1][0][-3:], ["rm", "--force", name])
        self.assertNotIn("private-test-secret", " ".join(run_args))
        self.assertEqual(calls[0][1]["input"], "private-test-secret")


if __name__ == "__main__":
    unittest.main()
