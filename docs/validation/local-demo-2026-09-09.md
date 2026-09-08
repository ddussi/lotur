# Local demo validation — 2026-09-09

This record covers the one-command runner and Vite example on `codex/oss-alpha-preparation`, based on `a541f3a`. It uses synthetic accounts, isolated databases, and loopback HTTP. Linux CI validation is pending; this is not evidence of a public HTTPS rollout.

## Implementation

`npm run demo` starts a dedicated Compose PostgreSQL project, applies the real migrations, prepares Argon2-backed accounts through the existing authentication service, runs the canary and admission approval, and launches the normal Gateway, Vite integration, and Client entrypoints. A separate DML role serves runtime queries. Production database/Gateway environment settings are excluded from child environments.

Generated state has owner-only directory/file permissions. One active runner owns each state directory. Normal shutdown stops only its own child processes and database container, retaining the volume. The explicit reset command deletes the dedicated project's volume and generated files. Interrupted temporary-password setup resumes from a private journal.

The [English](../local-demo.en.md) and [Korean](../local-demo.md) guides describe these commands and their limits. The [example](../../examples/vite-review/README.md) uses synthetic page state and stable element identifiers, without test-fixture imports or external services.

## macOS results

Environment: Node.js 24.12.0, Docker Engine 29.1.3, PostgreSQL 17.6, macOS arm64, Chrome through Playwright 1.62.1. The PostgreSQL image and npm dependencies were already cached for the timed run.

| Check | Result |
| --- | --- |
| Real demo browser suite | Two scenarios passed: full two-actor workflow plus restart; forced interruption during account setup plus recovery. |
| Authentication and isolation | Both users entered generated credentials through the normal login page. A duplicate runner was rejected without affecting the active one. The real canary checked unauthenticated rejection before admission. |
| Pins and drafts | An element-attached region followed a compact layout. Status filters and peer reply/workflow events preserved an unsent draft. |
| Notifications and workflow | Mention → reply → request review → request more changes → request review → confirm resolved. Separate browser contexts observed live state and persisted history. DB rows included MENTION, REPLY, WORKFLOW_REQUEST and WORKFLOW_RESULT notices. |
| Restart | Saved thread content, anchor, status, workflow version, reply rows and notification identities/reasons matched before and after restart. Passwords and permanent links remained; the temporary share URL changed. |
| Interruption | SIGKILL during account preparation left a recoverable journal and lock. Restart preserved configured account passwords and instance identity, completed setup, and cleared the journal. |
| Stop and reset | Graceful stop returned zero and removed readiness state. Explicit reset removed each test's Compose project and volume. No test demo container remained running. |
| Mobile example | At 390 CSS pixels, the page had no horizontal overflow and the review launcher left the app usable. Desktop/mobile screenshots were visually inspected. |
| Time to first saved feedback | 9.6 seconds in the first passing cached automated run, including startup and browser login. This excludes initial `npm ci` and image download and is not a cold-start or human usability claim. |
| Failure handling | Script checks covered missing Docker, remote Docker rejection, an occupied Gateway port, required reset intent, unchanged config/credentials, and released locks. The existing listener was preserved; failure paths did not invoke Docker container mutations. |
| Related verification | Build, typecheck and architecture boundaries passed; 64 script tests and all 19 existing browser tests passed, with no skips. The browser suite includes offline inbox access, concurrency, IME/draft behavior, Vite HMR and Next.js production exclusion. |
| Lint and documentation | Lint passed with the pre-existing one generated-file suppression warning and 50 informational suggestions. Internal Markdown links were checked after adding the guides. |

## Issue found and corrected

A quick **Request review** click immediately after **Reply** could be silently ignored: the thread already had a pending action, but only the Reply button was disabled. The shared thread view now disables every action that requires waiting for that thread, while draft editing and pin controls remain available. This busy state survives live re-renders.

The demo regression delays the successful reply response after its real database commit, waits for the SSE refresh, and verifies that Request review and Resolve remain disabled while the reply field remains editable. Releasing the response makes the next action available. Existing draft and workflow browser scenarios still pass.

## Remaining validation

- Linux CI must run the same suite on this branch before P3 is marked complete.
- First-download/install timing has not been measured in this cached macOS run.
- Native Windows, Safari and Firefox have not been verified.
- Full release-candidate checks, external Client installation, backup/restore, and a separate HTTPS candidate remain in the [alpha plan](../open-source-alpha-plan.md).

Private account files, database contents, runner logs and browser traces are not committed or uploaded. Screenshots use only the synthetic example and disposable account display names.
