# Install the standalone Client

[한국어](client-installation.md) · [Getting started](getting-started.en.md)

The Client can be installed from a generated `.tgz` without the source checkout, server code, PostgreSQL, or development dependencies. Node.js 24+ is required. There is no tagged release or npm registry publication yet; the following path builds a local archive from this source revision.

## Build the archive once

From the Review Tunnel repository root:

```sh
npm ci
npm run pack:client
```

The command prints the archive path, currently `dist/releases/review-tunnel-client-0.1.0.tgz`. To preserve previous files, it refuses to replace an existing archive. Use `npm run pack:client -- --output-dir dist/releases/another-build` for a separate output directory.

The archive contains the bundled application module, a `review-tunnel` command, a pinned copy of the required `ws` JavaScript dependency, and both licenses. It includes no installation hooks, optional native add-ons, Gateway, or DB driver. Its package metadata stays private to prevent accidental registry publication; local archive installation works normally.

## Install on the developer's computer

Copy the archive to that computer. In a dedicated directory outside the source checkout:

```sh
npm init -y
npm install --ignore-scripts /path/to/review-tunnel-client-0.1.0.tgz
npx --no-install review-tunnel --version
npx --no-install review-tunnel --help
```

Replace `/path/to/…` with the copied file's actual path. The required runtime is included, and installation is tested with `--offline` and an empty npm cache. An online registry is not needed for this archive's dependencies.

Keep your local app running, then use the installed command:

```sh
npx --no-install review-tunnel http://127.0.0.1:3000 \
  --gateway wss://control.tunnel.example.com/_review-tunnel/carrier \
  --username developer1 --review-project storefront --review-revision your-revision
```

Use your operator's Gateway address and a developer account whose initial password was changed through the login page. Enter the password at the hidden terminal prompt. Automated callers must explicitly add `--password-stdin` and provide exactly one password line; there is no password command-line argument.

The complete loopback origin is shared. A URL appears after activation and optional review binding succeed. `Ctrl+C` ends the share. An interrupted connection can resume the same URL within the Gateway's reconnect window. The [review setup guide](getting-started.en.md#enable-page-and-region-reviews) explains the separate app integration required for pins and comments.

## Validate or update

Reinstall a newer verified archive in the same dedicated directory and check `--version`. The Client's source, compiled Docker entrypoint, and standalone archive use the version from the same Client package manifest.

The [consumer validation record](validation/client-package-2026-09-09.md) describes the isolated installation and real Gateway checks. Versioned release downloads, checksums, and upgrade guarantees remain part of release preparation; an archive built locally is not automatically a published release.
