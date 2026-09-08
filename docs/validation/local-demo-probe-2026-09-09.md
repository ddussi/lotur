# Local authenticated demo feasibility — 2026-09-09

The underlying authenticated flow is verified; the complete one-command demo runner and Vite example are still being implemented. This record covers a loopback HTTP experiment with synthetic accounts and a separate local database, not a production HTTPS rollout.

## Environment and changes

- Node.js 24.12.0, PostgreSQL 17.6, Docker 29.1.3 on macOS arm64, local Google Chrome through Playwright.
- PostgreSQL runs from [the demo Compose configuration](../../compose.demo.yml), with a named volume and a port published only on `127.0.0.1`.
- Gateway, Client and the existing canary script use their normal entrypoints. The experiment's small HTTP app includes the normal review bootstrap script.
- A [demo-only DNS preload](../../scripts/demo/loopback-dns.mjs) resolves the control/content `.localhost` namespace within those Node processes. It does not edit system DNS or hosts files.
- [Gateway configuration](../../apps/gateway/src/config.ts) now accepts an explicit Control port, retaining hostname-based separation from the content wildcard. [Review context](../../apps/gateway/src/server.ts) preserves that authority in permanent links.

## Observed results

| Check | Result |
| --- | --- |
| Prior failure reproduced | The configuration regression failed because a Control authority containing a port was rejected as a bare DNS name. |
| Targeted regression suite | 33 tests passed: configuration, authentication and revocation, web-auth boundaries, review API context, and DNS namespace delegation. No skips. |
| Static checks | TypeScript and lint checks passed. The broader pre-existing source tree has informational lint suggestions and one generated-file suppression warning; the six modified/new source and test files passed the focused warning-level lint check. |
| Database initialization | Existing Admin CLI migrations initialized the database; a separate DML runtime role served the Gateway and account operations. |
| Account flow | Real Argon2-backed administrator, developer and reviewer accounts initialized through the existing authentication service and password-change flow. |
| Canary and admission | Existing canary verified unauthenticated rejection, authenticated response, request streaming, SSE and WebSocket. Admin CLI recorded the result and approved the deployment. |
| Startup ordering | Starting the Client immediately after DB approval could race Gateway's operational-state poll and fail activation. Waiting for the protected admission metric to report ready resolved the race. Dependency health alone is not this readiness signal. |
| Browser flow | Chrome followed the content-to-control login redirect on the configured port, authenticated the reviewer, saved feedback on the app, and opened its permanent link in the inbox on the same Control port. |
| Database restart | One saved comment was present before and after stopping/restarting the same database volume. Repeating migration/account initialization and the browser flow preserved it and added a second comment. |

Raw probe code, generated local credentials and process logs are private operations evidence, excluded from tracked source and Docker contexts. The public summary intentionally omits account secrets and machine paths.

## Remaining P3 work

- Package this proven sequence into a user-facing runner with ownership-safe shutdown, initialization recovery, persistent state, clear port/Docker errors, and an explicit data-reset command.
- Add the actual Vite demo app, accessible onboarding instructions, and a repeatable browser scenario for pins, replies, notification delivery and re-review by two users.
- Verify the runner in a clean macOS environment and Linux CI, including restart behavior, and record the time to first feedback.
- Use that final runner's reproducible validation as the release evidence. This feasibility experiment does not replace the required full candidate, backup/restore or HTTPS checks.

Track completion in the [alpha preparation plan](../open-source-alpha-plan.md).
