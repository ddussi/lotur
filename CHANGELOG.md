# Changelog

Changes awaiting a tagged release are recorded under Unreleased. The package version is currently `0.1.0`; that number alone does not establish that a release has been published.

The first planned distribution is `v0.1.0-alpha.1`. Standalone Client installation and the local demo remain release-preparation work until their implementation and consumer validation are recorded.

## Unreleased

### Fixed

- Accept explicit Control host ports for local authenticated setups and non-default HTTPS entrypoints. Preserve that port in login redirects and permanent review links while rejecting a control hostname inside the content wildcard.

- Preserve request isolation when oversized HTTP/WebSocket metadata is rejected; apply the same shared-content role policy at first access and periodic authorization revalidation.
- Serialize review event writers per feed, use a consistent read snapshot, and resynchronize expired cursors without silently omitting comments.
- Refresh already-loaded older comments and replies; preserve versioned drafts during live updates, navigation, failed requests, concurrent editing, and text composed while a submission is pending.
- Keep the deployed event-retention migration at 18 and add workflow/notification migrations 19–21. Detect the historical local schema that used 18 differently; preserve review data and migration timestamps on repeated upgrades.
- Use platform-independent screenshot output paths in Linux CI and repository-relative links in historical documentation.

- Create review tables from the documented administrator migration command for both new installations and upgrades from sharing-only databases.

- Reject malformed WebSocket Upgrade targets without terminating the Gateway.
- Dispose of creating, reconnecting, and resuming sessions when sharing is stopped or authorization is revoked; reject attempts to resume terminated sessions.
- Handle idle PostgreSQL connection errors without crashing, close admission while state is unavailable, and recover using persisted operational state.
- Preserve valid browser form origins and complete cross-host login/password-change flows without weakening form CSP or exact-origin checks.
- Finish queued HTTP and WebSocket writes before removing stream state.
- Wait for pending review binding cleanup before completing Gateway shutdown, including already-disconnected tunnels.
- Keep the Next.js test fixture's interactive buttons disabled until hydration completes.

### Added

- Responsive element-anchored pins, per-pin visibility and jump controls, server-side status/author filters, and a collapsible mobile review panel.
- A persistent `/reviews` inbox with project/revision/path navigation, permanent comment links, offline conversation access, and links back to active shares of the same revision.
- Reply-participant notifications, cross-project notification pagination and unread filters, and participant mention completion.
- Opt-in re-review requests, author confirmation/change requests, round-specific notifications, versioned workflow transitions, and persisted processing history.
- Verified-main GitHub Actions image publication, deployment over SSH, and previous-container recovery when rollout checks fail.
- English and Korean review guides, a current documentation index, and separately labeled historical implementation records.

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
- Use reserved example domains in installation instructions and anonymized published validation summaries.
- Install the Chrome channel explicitly in CI to match the browser test configuration.

### Upgrade notes

- Run the administrator migration command before starting a Gateway requiring review schema 21. Existing migration 18 must retain its deployed meaning; never renumber an applied production migration manually.
- Upgrade every Gateway reading that database before enabling `REVIEW_WORKFLOW_ENABLED=true`. The runtime defaults to disabling new re-review requests; existing pending requests and their history remain readable and actionable.
- Gateway restart ends active tunnel URLs. Restart sharing with the same owner/project/revision to retrieve saved feedback under a new URL.
- Drafts are held in the current browser tab's memory. Reloading or closing the tab discards unsaved text.

Project-level access lists, review-capture screenshots, external notifications, automatic revision carry-over, and complete edit history remain outside the current scope.
