# Changelog

Changes awaiting a tagged release are recorded under Unreleased. The package version is currently `0.1.0`; that number alone does not establish that a release has been published.

## Unreleased

### Fixed

- Create review tables from the documented administrator migration command for both new installations and upgrades from sharing-only databases.

- Reject malformed WebSocket Upgrade targets without terminating the Gateway.
- Dispose of creating, reconnecting, and resuming sessions when sharing is stopped or authorization is revoked; reject attempts to resume terminated sessions.
- Handle idle PostgreSQL connection errors without crashing, close admission while state is unavailable, and recover using persisted operational state.
- Preserve valid browser form origins and complete cross-host login/password-change flows without weakening form CSP or exact-origin checks.
- Finish queued HTTP and WebSocket writes before removing stream state.
- Wait for pending review binding cleanup before completing Gateway shutdown, including already-disconnected tunnels.
- Keep the Next.js test fixture's interactive buttons disabled until hydration completes.

### Added

- Project/revision-bound page and region reviews with replies, resolve/reopen, versioned author edits, and deletion markers.
- PostgreSQL review persistence, paginated reads, replayable review SSE, participant mentions, and recipient-only internal notifications.
- Development-only Vite and Next.js integrations with standalone tarball installation and production HTML exclusion checks.

- Regression coverage for transport lifecycle races and a real Gateway process losing an idle PostgreSQL connection.
- Authenticated Vite and Next.js browser scenarios covering login, cookies, refresh, revocation, and password changes.
- An opt-in public HTTPS browser suite, `npm run test:frameworks:public`, and an anonymized validation report.
- English/Korean setup documentation, contributor and security guidance, issue/PR templates, and a release procedure.
- MIT license, matching workspace package metadata, and license inclusion in runtime Docker images.

### Changed

- Extract local-origin resolution and WebSocket Upgrade validation from the Client transport.
- Use controlled clocks in timing-sensitive transport tests.
- Document sharing and implemented reviews separately from deferred project-specific authorization.
- Separate production Docker dependencies from development workspaces and add Biome lint checks.
- Allow `DEVELOPER` as well as `REVIEWER` to access shared content; `ADMIN` alone does not grant access.
- Use example domains and anonymized evidence throughout public documentation.
- Install the Chrome channel explicitly in CI to match the browser test configuration.

Project-level access lists, screenshots, external notifications, automatic revision carry-over, and complete edit history remain outside the current scope.
