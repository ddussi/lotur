# Open-source publication preflight — 2026-09-09

This is a scoped publication review, not a claim that a release has shipped or an independent security certification. The review covered `0f00fe6` locally and remote `main` at `41e9570`. New artifacts and subsequent changes must be checked again before publication.

## Inspected scope

| Surface | Evidence and result |
| --- | --- |
| GitHub visibility and refs | Repository private; one remote branch, `main`; no published release or tag at the preceding inventory. Local backup/work branches remain private local refs. |
| Current source | 267 tracked files copied to an isolated scan directory; untracked local backups and configuration excluded from the intended publication set. |
| Reachable history | 51 commits across all local refs; 666 historical file blobs also inspected for known deployment hosts and personal filesystem paths. Remote `main` matched the local tracking ref. |
| Actions | All 12 existing runs had retrievable logs and were scanned. No downloadable Actions artifacts were listed. |
| Credential scan | Official Gitleaks 8.30.1 binary, release SHA-256 verified, default rules with full redaction and inline allow comments ignored. 12 historical and 12 current-source candidates were inspected in their source context: all were a fixed WebSocket handshake nonce in four test files. No credential candidates were reported in Actions logs. |
| Runtime dependency metadata | The production lockfile declares 27 dependency package entries: 23 MIT and 4 ISC. Actual distribution license files and notices remain part of release packaging verification. |
| Registry inventory limitation | The current local GitHub credential cannot list container-package settings because it lacks `read:packages`. CI identifies Gateway, Admin CLI and canary image names, but package visibility is not asserted by this review. Package settings and anonymous access must be verified in the release stages. |
| CI separation | Pull requests run verification with read permissions and an isolated test database. Image publication requires `main`, a push/manual event, and the explicit auto-deploy variable. Deployment requires successful publication and uses the production environment. |

Scanner output alone cannot establish the absence of credentials. The named candidates were reviewed, and operational metadata was inspected separately. Raw logs and redacted scanner reports are retained in a private, untracked audit directory; they are not publication artifacts.

## Findings and disposition

| Finding | Action | Publication condition |
| --- | --- | --- |
| Three historical document blobs contain personal absolute paths. | Fix current documentation to use repository links and label historical records. Preserve original commits as requested. | Include the remaining historical metadata in the final disclosure review; do not imply that changing the current file erases its history. |
| Three deployment runs expose connection host/user/port in their environment listing. Secrets such as the SSH key and registry token are masked; the endpoint metadata is still visible. | Preserve private copies and prepare a change to use masked deployment connection settings for future runs. The affected run IDs are `34199877683`, `34200823193`, and `34220306237`. | Decide the treatment of these existing logs in the final publication approval. Keep a non-sensitive validation summary even if logs are removed. |
| Current documentation mixes historical uncommitted states with current usage; the English review guide is incomplete. | Separate current guides from dated evidence; update both languages and the changelog. | Check links, commands, feature boundaries and dates again on the release candidate. |
| Client has no standalone installation artifact; image publishing currently serves the configured deployment. | Create and inspect the Client/integration archives and supported versioned images in later stages. | Do not present private images or unpublished packages as anonymously downloadable. |

No automatic history rewrite, remote log deletion, repository visibility change or release publication was performed during this preflight. Public visibility must also be checked for associated packages, new workflow artifacts and the final release assets.

## Follow-up evidence

- The later [candidate image validation](candidate-images-2026-09-09.md) published and pulled all six runtime targets under unique private candidate tags. API checks confirmed private visibility for the existing Gateway/Admin CLI/canary packages and the new Client/backup/restore packages. Source/package files and image metadata are now retained as private seven-day CI artifacts; the initial inventory above predates those artifacts.
- On 2026-09-09, the authenticated GitHub package list showed `lotur-gateway`, `lotur-admin-cli`, and `lotur-canary-check` as **Private**, linked to this repository. This closes the initial visibility inventory gap for those three packages; it does not establish anonymous access or the visibility of future packages. The local API credential still lacks `read:packages`.
- The existing production environment values for `DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_PORT` were copied to same-named Secrets in the same repository/environment, and their presence was verified without printing their values. The preparation branch's deployment workflow now references those Secrets. Original Variables remain for the older workflow on `main`. Future masking must also be checked in the eventual deployment log; this change does not alter the three historical logs listed above.
- Current implementation: [status](../poc-status.md).
- Required later checks and final publication boundary: [alpha preparation plan](../open-source-alpha-plan.md).
- GitHub describes Actions log visibility when a repository becomes public in [repository visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
