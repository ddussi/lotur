# Standalone Client validation — 2026-09-09

The Client packaging implementation follows the local demo commit `d67d097` on `codex/oss-alpha-preparation`. This record covers macOS arm64 validation; the complete release candidate and versioned publication remain pending.

`npm run pack:client` bundles the existing Client source and allowed internal modules through the repository's build dependency. It rejects unexpected external or internal modules. Only Node built-ins and the pinned `ws` runtime remain external; the archive includes an unmodified JavaScript copy of `ws` and its license. The installer executes no hooks and does not fetch an unpublished workspace package.

Verified with Node.js 24.12.0, npm, PostgreSQL 17.6, Docker 29.1.3, Chrome/Playwright 1.62.1, and Python's standard-library PTY harness:

| Check | Result |
| --- | --- |
| Fresh consumer | Installed the archive outside the repository, with empty npm/user configuration and cache, an unreachable registry, and `npm install --offline --ignore-scripts`. |
| Package contents | Explicit 25-file archive inventory: Client bundle/entrypoint, package metadata/docs/licenses, and ws runtime. No server/DB packages, tests, secrets, logs, source maps, native add-ons, or workspace symlinks. |
| Versions and commands | Installed `--help` and `--version` worked without a server. The compiled Docker-style Client entrypoint reported the same `0.1.0`. Unknown options exited 1 with a usage message and no stack dump. A nonterminal password request failed with the explicit stdin instruction. |
| Hidden prompt | An actual PTY launched the installed Client, waited for terminal echo to be disabled, then entered its generated developer password. The prompt appeared; the password did not appear in captured output. |
| Real sharing | The installed Client authenticated with the real demo Gateway, activated a second share, bound its own project/revision, loaded the Vite app in Chrome, and saved a review. |
| Reconnection | A test proxy dropped the carrier connection. The installed Client authenticated a resume, reported recovery, and served the same URL with the saved review after reload. Login and carrier used the same proxy authority, preserving the CLI's existing origin rule. |
| Normal shutdown | SIGINT forwarded through the terminal harness returned zero. The permanent review link remained accessible and its ended share was no longer offered as an active app link. |
| Binding failure | A second test proxy rejected only the real review-binding request. The installed Client exited 1, did not print a ready URL, closed its carrier, and successfully logged out. The Gateway's active tunnel count returned to the original demo share alone. |
| License and preservation | Project and ws licenses matched their source files. An existing output archive was preserved when packaging again. |

The loopback DNS preload and PTY/proxy helpers are explicit test-harness files copied into the external consumer directory. They are not dependencies of the installed Client. Normal team deployments use their operator's DNS and TLS.

The standalone Vite/Next installation/import check also passed. The three framework browser scenarios now first pack the integration, install that archive into each fixture app, and verify that ESM resolves the installed file rather than the workspace package. All three passed on macOS: authenticated Vite HMR/revocation, Next RSC/Server Actions/navigation/Fast Refresh/revocation, and Next production HTML without the review bootstrap. Framework runtimes still come from the harness's pinned development dependencies; the separate outside-repository installation test verifies the integration packages' independent imports.

Linux verification of the Client change, final version/checksum selection, runtime-image verification, and the full candidate gate remain outstanding. No archive has been published as a release.
