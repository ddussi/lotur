# Try the local demo

[한국어](local-demo.md) · [Overview](../README.md)

The demo runs a small Vite app, a Gateway, a Client, and a dedicated PostgreSQL database on your computer. It creates local developer and reviewer accounts so you can try pins, replies, notifications, and re-review before operating a server. The generated URLs work only on this computer.

## Start

Use Node.js 24+, a running **local Docker Engine 28+** with Docker Compose, and Google Chrome. From a source checkout:

```sh
npm ci
npm run demo
```

The first run downloads the pinned PostgreSQL image if it is missing. The runner applies the real database migrations, creates accounts, checks the local authentication and streaming path, approves sharing for this demo, and starts the example. No domain, certificate, or system hosts-file edit is required.

Wait for **Demo ready**. Keep that terminal running. Open the printed **Shared app** URL in Chrome. In another terminal, show the generated local credentials:

```sh
npm run demo -- credentials
```

Use a regular Chrome window for `reviewer` and an Incognito window or a separate profile for `developer`. Each uses its own randomly generated password. Two tabs in the same profile share a login. The demo prepares the initial passwords for you; no separate password-change step is needed.

Credentials and state live in the ignored `.review-tunnel-demo/` directory, with private directory/file permissions. The start command prints the credentials file path, not passwords. The `credentials` command deliberately prints both local passwords; do not include its output in bug reports.

## Try a complete review

1. As `reviewer`, open the shared app and choose **Select area or pin**. Drag across part of the project card, then write `@developer Please check this spacing.` and choose **Comment**.
2. Close the review panel and choose **Try compact layout**. The pin follows the card. Reopen the panel, try its status filters, and copy the comment's **Permanent link**.
3. As `developer`, open that link. Expand the notification inbox, reply to the comment, and choose **Request review**.
4. As `reviewer`, open the same permanent link. Read the reply and notification. Choose **Request more changes**, or **Confirm resolved** when satisfied. Both users see live status updates and the processing history.
5. Open the printed **Review inbox** URL to browse saved feedback. You can also edit the [example source](../examples/vite-review/src/main.js); Vite updates the running app.

Saved reviews belong to the fixed `launch-checklist` project and `demo-v1` revision. The example's checklist is disposable page state; changes to it reset on reload. Submitted review text is stored in PostgreSQL. Unsent review drafts survive live updates and filter changes in their current tab, but not a page reload or closing that tab.

## Stop, resume, or delete

Press `Ctrl+C` in the demo terminal. The runner stops its own Gateway, Client, app, and database container, retaining the database volume and credentials. While the runner is stopped, its inbox is also offline.

Run `npm run demo` again to resume. The shared app gets a new temporary URL; saved comments, replies, notifications, account passwords, and permanent comment links remain. The Gateway must be running to open those links.

To delete **this demo's saved reviews, accounts, and generated credentials**, stop it first and run:

```sh
npm run demo -- reset --confirm-delete-demo-data
```

This removes the dedicated Compose project's database volume and generated state files. It preserves the example source. A later start creates a fresh demo.

## Ports and troubleshooting

The default loopback ports are `8788` (Gateway), `5178` (Vite), and `54339` (PostgreSQL). Choose three different unused ports on the first start if needed:

```sh
npm run demo -- --state-dir .review-tunnel-demo/alternate \
  --gateway-port 8789 --app-port 5179 --database-port 54340
npm run demo -- credentials --state-dir .review-tunnel-demo/alternate
```

Pass the same `--state-dir` to later start, credentials, and reset commands. Existing state keeps its configured ports; the runner rejects attempts to change them in place. Use an empty, dedicated directory and keep it out of version control.

| Symptom | Action |
| --- | --- |
| Docker command fails | Start the local Docker engine and check `docker info` and `docker compose version`. Remote Docker contexts are rejected. |
| A port is unavailable | Stop the service occupying it yourself, or start a separate demo with three unused ports. The runner does not terminate other processes. |
| Another demo already uses the state directory | Return to its terminal and stop it with `Ctrl+C`. A later run can reclaim a lock only after its recorded process has exited. |
| Startup fails | Read the private `runner.log` in the state directory. Normal failures stop owned processes and preserve data. Retry after addressing the reported cause. |
| Account setup was interrupted | Start again with the same state directory. The runner resumes its saved temporary-password change without replacing the database. |
| Browser cannot open a generated `.localhost` address | Use Chrome and check proxy/VPN settings for loopback traffic. The Node processes have their own local name mapping; the runner does not change system DNS. |

The demo uses HTTP solely on loopback. Its child processes do not inherit production database or Gateway configuration. This setup does not test public DNS, TLS, or access from another device; use the [Gateway setup guide](getting-started.en.md#install-a-gateway-prerequisites) for team sharing.
