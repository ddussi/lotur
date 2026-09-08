# Getting started

[한국어](getting-started.md) · [Project overview](../README.md)

Review Tunnel connects a local web application to a Gateway operated by you or your team. The maintainers do not supply a hosted service or shared domain. All `tunnel.example.com` names below are placeholders to replace with your operator's domain.

## Use an existing Gateway

You need Node.js 24+, a source checkout of this repository, and a `DEVELOPER` account. Download the repository and run `npm ci` from its root. If you were issued a temporary password, sign in at your Gateway's control host `/login` and change it before using the Client.

1. Start the app you want to share in its own project directory. Keep that process running.
2. In a second terminal, enter the Review Tunnel repository root and run:

```sh
npm run share -- http://127.0.0.1:3000 \
  --gateway wss://control.tunnel.example.com/_review-tunnel/carrier \
  --username developer1
```

3. Replace the port and Gateway hostname, enter your password when prompted, and send the printed URL to a reviewer.
4. The reviewer opens the URL and signs in with a `REVIEWER` account. They need no Client installation, SSH access, or domain of their own.
5. Make changes locally and review them through your framework's supported live update mechanism. Enable review mode below to exchange comments, region pins, and replies directly on the page.
6. Press `Ctrl+C` in the sharing terminal to stop. Your computer, local app, and Client must remain running during the share.

One Client shares an entire loopback HTTP origin. Browser requests to another `localhost` port refer to the reviewer's machine; configure the app to proxy its API under the shared origin if necessary. Either `DEVELOPER` or `REVIEWER` grants content access; `ADMIN` alone does not.

Developers and reviewers have deployment-wide access to known share URLs. There are no per-project access lists. A share lasts at most 8 hours, expires after 30 idle minutes when no streams remain, and can resume at the same URL within a 2-minute reconnect window. Gateway restart ends active shares; a new share gets a new URL.

## Enable page and region reviews

Reviews are optional. Enable a development integration in the app being shared, then bind the share to a stable project slug and an immutable revision key. Both CLI options are required together:

```sh
npm run share -- http://127.0.0.1:3000 \
  --gateway wss://control.tunnel.example.com/_review-tunnel/carrier \
  --username developer1 --review-project storefront --review-revision 4a1b2c3d
```

The Client prints the URL only after activation and review binding succeed. If binding fails, it closes that new tunnel. With the same owner, project, and revision, a later tunnel can retrieve persisted feedback. A new revision has its own feedback.

Build local integration tarballs from the **Review Tunnel repository root**:

```sh
npm pack ./apps/vite-integration
npm pack ./apps/next-integration
```

In the **web app's project directory**, install only the integration you use. Replace the example filesystem path with your checkout path. These commands use local tarballs and do not assume a published npm release:

```sh
# Vite app
npm install --save-dev /path/to/review-tunnel/review-tunnel-vite-0.1.0.tgz
# Next.js app
npm install --save-dev /path/to/review-tunnel/review-tunnel-next-0.1.0.tgz
```

For Vite, add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { reviewTunnel } from "@review-tunnel/vite";

export default defineConfig({ plugins: [reviewTunnel()] });
```

For Next.js App Router, configure the controlled preview origins in `next.config.mjs`:

```js
import { withReviewTunnel } from "@review-tunnel/next";

export default withReviewTunnel({}, {
  allowedDevOrigins: ["*.preview.tunnel.example.com"],
});
```

Add the development script in `app/layout.jsx`:

```jsx
import Script from "next/script";
import { reviewTunnelScriptProps } from "@review-tunnel/next";

export default function RootLayout({ children }) {
  const scriptProps = reviewTunnelScriptProps();
  return <html><body>
    {children}
    {scriptProps === undefined ? null : <Script {...scriptProps} />}
  </body></html>;
}
```

The Vite plugin applies only during development. The Next helpers are disabled by default when `NODE_ENV=production`, and the browser suite checks that the production HTML omits the bootstrap. Integrations add the script; they do not start a hidden Client. Keep the explicit sharing process running.

For another framework, add this to a review-only HTML entry. The Gateway does not rewrite app HTML:

```html
<script type="module" src="/_review-tunnel/review/bootstrap.js"></script>
```

If your app uses a nonce-based CSP, pass the same per-response nonce to `reviewTunnel({ nonce })` or `reviewTunnelScriptProps(undefined, nonce)`, or set it on the explicit script tag. The overlay carries it into its styles. Keep the app's CSP intact.

The sidebar supports page comments, click pins, drag-selected regions, and replies for both content roles. Authors can edit their own live text. Authors or developers can delete it, removing the text and leaving a deletion marker. Developers can resolve or reopen threads; resolved threads reject replies and edits until reopened. Concurrent updates use version/status checks and report a conflict instead of silently overwriting.

Mentions notify only the project owner or existing participants in that revision. Replies also notify the original author and existing reply participants, excluding the sender and duplicate mention notifications. Notifications are visible only to the recipient and stay inside Review Tunnel. Review changes arrive through a separate SSE connection. Page navigation reloads feedback for the current path. Per-project membership, screenshots, external alerts, automatic revision carry-over, and complete edit history are outside this alpha.

Open `/reviews` on the control host to browse saved reviews across projects and revisions, filter by page/status/author, and see your notifications. Permanent links return to the same comment after sign-in; conversations remain available after a share ends. The [review guide](review-guide.en.md) covers inbox editing, pin controls, notifications, and optional re-review requests. Re-review requires migrations 19–21 and `REVIEW_WORKFLOW_ENABLED=true` for new requests.

Live updates, filter changes, and in-app navigation preserve current-tab drafts. Reloading or closing the tab loses unsaved text. A concurrent edit shows a conflict while retaining your draft so you can compare it with the latest version.

### Pin placement and visibility

Click **Hide all pins** to hide the markers while keeping every comment in the sidebar. Click **Show pin** on a comment to display that pin, and **Hide pin** to turn it off again. **Show all pins** restores all loaded pins. The global setting survives reloads in the same browser tab; individual choices survive live comment updates but reset on navigation or reload. These controls affect your view, not other reviewers or saved comments. Region interiors remain clickable and use a light tint.

Click the **Pin #…** button to reveal and jump to that pin, including when it is already enabled but outside the viewport.

Give important elements a stable identity that stays the same across screen sizes:

```html
<button data-review-id="checkout-submit">Place order</button>
```

For a new click or drag selection, the overlay looks for a unique `data-review-id`, then a unique `id`, on the element under the selection's center or its ancestors. The entire selection must fit inside that element. A whole-page wrapper `id` is excluded. The pin stores its relative position inside the identified element and follows that element when responsive layout, scrolling, or DOM updates move it. This identifies a DOM element, not a React component or a particular line of text. Use small, meaningful targets and keep identities unique and stable; reusing an identity for different content can still misplace feedback.

When the element is missing, hidden, or its identity is duplicated, its marker is hidden and the sidebar explains why. It reappears when the target becomes available, unless you turned that pin off. The overlay does not guess a replacement element.

Selections without a suitable identity, including existing pins, keep page coordinates. They show a dashed outline, an **Approximate page coordinates** label, and the original viewport dimensions in CSS pixels. If the current viewport width or document dimensions differ by more than 2 CSS pixels, the marker is hidden with a layout notice. Matching dimensions cannot guarantee matching content, so these remain approximate. Existing pins do not gain element identities automatically; create a new pin after adding an identity when precise placement across layouts matters. Screenshots, text-range tracking, and targeting inside iframes or Shadow DOM are not provided.

## Install a Gateway: prerequisites

The remaining steps are for the operator, once per deployment.

- Linux server or container environment and PostgreSQL 15+. The pinned CI database is PostgreSQL 17.6.
- A domain you control, with control and wildcard DNS records pointing to your reverse proxy.
- TLS certificates for `control.tunnel.example.com` and `*.preview.tunnel.example.com`.
- A reverse proxy that forwards the original Host, supports HTTP streaming, SSE, and WebSocket upgrades, and sanitizes forwarding headers.
- Private storage/injection for database credentials, HMAC keys, canary and metrics tokens, plus a database backup plan.

```text
control.tunnel.example.com             login, accounts, Client API and WSS
*.preview.tunnel.example.com           temporary content hosts
canary.preview.tunnel.example.com      reserved check covered by the wildcard
```

The control host must be outside the content wildcard. A new share does not need a new DNS record or certificate. Check cookie policies of sibling services when sharing a parent domain. Use one Gateway instance; tunnel routes are held in its memory, not shared through PostgreSQL.

## Configure and initialize

Install dependencies with `npm ci`. For container deployment, build the named `gateway` and `admin-cli` targets from the [Dockerfile](../Dockerfile). The [Linux runbook (Korean)](linux-deployment.md) documents all runtime targets and operational controls.

Inject configuration through your process manager or secret manager. The application does **not** automatically read `.env`; [.env.example](../.env.example) is a reference. Core settings are:

```dotenv
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=8787
CONTENT_DOMAIN=preview.tunnel.example.com
PUBLIC_CONTENT_ORIGIN=https://preview.tunnel.example.com
CONTROL_HOST=control.tunnel.example.com
DATABASE_URL=<runtime PostgreSQL connection URL>
AUTH_SESSION_HMAC_KEY=<canonical base64url encoding of 32 to 128 random bytes>
DEPLOYMENT_ID=<your release identifier>
DEPLOYMENT_CONFIG_DIGEST=sha256:<64 lowercase hexadecimal characters>
CANARY_HOST=canary.preview.tunnel.example.com
CANARY_BEARER_TOKEN=<separate random token of at least 32 characters>
METRICS_BEARER_TOKEN=<another random token of at least 32 characters>
```

Replace every placeholder. Restrict `TRUSTED_PROXY_CIDRS` to the actual proxy peers when using `X-Forwarded-For`; it is unset by default. Keep Gateway and database listeners reachable only by the intended peers. Use the same operational limits and HMAC configuration for the Gateway and administrative jobs.

If reviewers reach the control host on a non-default port, include it in `CONTROL_HOST`, for example `control.tunnel.example.com:8443`. This preserves the port in sign-in redirects and permanent review links. `CONTENT_DOMAIN` and `CANARY_HOST` remain bare DNS names; set the content port in `PUBLIC_CONTENT_ORIGIN`. The control hostname must still be outside the content wildcard, regardless of its port.

Run migrations with a dedicated DDL database role. This initializes authentication, operational state, and review tables, including an upgrade from a sharing-only database:

```sh
npm run admin -- migrate
```

Switch `DATABASE_URL` to a DML role for normal administration and Gateway operation. With that URL and `AUTH_SESSION_HMAC_KEY` injected, initialize the administrator:

```sh
npm run admin -- bootstrap --username admin --display-name "Operations Admin"
npm run admin -- change-password --username admin
```

The bootstrap command prints a temporary password once; the change command prompts for the current and new passwords. Routine administration does not run migrations automatically.

Build and start the Gateway with its runtime configuration injected:

```sh
npm run build
node dist/apps/gateway/src/main.js
```

For a persistent deployment, use your process manager or the Gateway Docker target with appropriate restart and resource limits. Verify `/health/live` and `/health/ready` through the control host. Readiness is distinct from permission to create shares.

## Verify the public path and allow sharing

From a machine that reaches the same HTTPS path as reviewers, supply the canary token privately and run:

```sh
CANARY_CONTENT_URL=https://canary.preview.tunnel.example.com \
npm run verify:public-path
```

After it passes, run these administrator commands with the database/HMAC configuration and the exact deployment identity available in that shell:

```sh
npm run admin -- record-canary --as admin --result passed \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
npm run admin -- approve-admission --as admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
npm run admin -- admission-status --as admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
```

These commands prompt for administrator reauthentication. Proceed when the result reports `admissionReady: true`. Record a failed canary as `--result failed` and resolve the failure before approval. A canary success alone does not enable shares.

Sign in as administrator at the control host `/admin/users`, create developer and reviewer accounts, and have each user change their temporary password. Create separate accounts for the [public HTTPS browser tests](public-path-testing.md), which intentionally revoke the test reviewer's sessions.

## Operate and troubleshoot

| Symptom | Check |
| --- | --- |
| Client requires a password change | Complete the initial change in the control-host browser UI |
| Shared page returns 403 | The viewing account needs `DEVELOPER` or `REVIEWER` |
| No new share can activate | Database availability, matching canary/approval identity, kill switch, and capacity limits |
| Page loads but streaming or HMR fails | Request/response buffering and WebSocket forwarding at the reverse proxy |
| Browser tests cannot find an executable | Install Chrome as described in [CONTRIBUTING.md](../CONTRIBUTING.md) |
| A revoked reviewer signs in again | Revocation ends existing sessions; disable the account or remove its role to deny later logins |

Before production use, complete backups and an isolated restore drill, key rotation, resource/load verification, and monitoring appropriate to your deployment. Consult the [security policy](../SECURITY.md), [account operations (Korean)](internal-account-operations.md), and [Linux runbook (Korean)](linux-deployment.md).
