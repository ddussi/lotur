"""Fixed SSH entrypoint; install beside deploy_gateway.py and bind a dedicated key to it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

import deploy_gateway as deployment


def receive(root, stream, command):
    deployment.require(command == "deploy", "Only the deploy command is permitted")
    line = stream.readline(16385)
    deployment.require(len(line) <= 16384 and line.endswith("\n"), "Invalid release envelope")
    manifest = json.loads(line)
    deployment.validate_manifest(manifest)
    installed = hashlib.sha256(Path(deployment.__file__).read_bytes()).hexdigest()
    deployment.require(manifest.get("workerDigest") == installed,
                       "Deployment worker changed; install the reviewed server worker before deploying")
    with tempfile.TemporaryDirectory(prefix="lotur-release-") as directory:
        path = Path(directory) / "release.json"
        path.write_text(json.dumps(manifest))
        deployment.main(["--root", str(root), "--manifest", str(path)])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        receive(args.root, sys.stdin, os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    except (deployment.DeploymentError, ValueError, OSError, KeyboardInterrupt) as error:
        print(f"Deployment rejected: {error}", file=sys.stderr)
        raise SystemExit(1) from None
