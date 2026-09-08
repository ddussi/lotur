# Review Tunnel Client

Connect a local web application to your team's authenticated Review Tunnel Gateway. This package contains the Client and its required JavaScript WebSocket dependency. It requires Node.js 24+ and does not need a source checkout, PostgreSQL, or a Gateway process on your computer.

Install a locally built or verified release archive in a dedicated directory:

```sh
npm install --ignore-scripts /path/to/review-tunnel-client-VERSION.tgz
npx --no-install review-tunnel --version
npx --no-install review-tunnel --help
```

Keep your web app running, then share its loopback HTTP origin:

```sh
npx --no-install review-tunnel http://127.0.0.1:3000 \
  --gateway wss://control.tunnel.example.com/_review-tunnel/carrier \
  --username developer1 --review-project storefront --review-revision your-revision
```

Replace the example Gateway name with the address issued by your operator. Enter your developer password at the hidden terminal prompt. Change any initial temporary password through the Gateway login page before using the Client. For automation, supply exactly one password line on stdin and explicitly use `--password-stdin`; there is no password argument.

The Client prints a URL after activation and optional review binding succeed. Reviewers open it and log in through a browser. Press `Ctrl+C` to close the share. Review mode also requires a development integration in the app. Sharing alone does not add an overlay.

Content access is deployment-wide for developer/reviewer roles; per-project access lists are not implemented. One Client shares the complete local origin. Reviews persist for the same owner/project/revision; a new revision has separate feedback.

The package is marked private to prevent accidental npm registry publication. Installation from an archive is supported. See the source repository's README and security policy for release status, setup, and reporting. Review Tunnel is MIT licensed; the bundled ws dependency's license is included in `THIRD_PARTY_NOTICES.md` and `node_modules/ws/LICENSE`.
