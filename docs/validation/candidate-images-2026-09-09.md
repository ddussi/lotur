# Private candidate images — 2026-09-09

This validates the image publication path for an early candidate. It is not a public release or production rollout. PostgreSQL was still 17.6 in this candidate; the subsequent 17.11 security refresh must be validated before final publication.

See the later [refreshed candidate result](candidate-refresh-2026-09-09.md) for PostgreSQL 17.11, actual restoration and included runtime notices.

- Source: `509667ea2129e25665262289db3c8915a9cf4b46`; version `0.1.0-alpha.1`.
- [CI run 34258812926](https://github.com/ddussi/lotur/actions/runs/34258812926) passed verification, package inventory and candidate images. Normal production publish/deploy jobs were skipped.
- 74 script tests, 359 application/PostgreSQL tests, 19 framework browser cases and 3 demo/installed-Client cases passed: 455 total, zero skips. Production npm audit found zero vulnerabilities. This audit does not cover the PostgreSQL binary or the base operating system.
- All six targets built for `linux/amd64`, passed invalid-configuration/entrypoint checks before pushing, and were pulled by digest and checked again. Pulled platform, image configuration identity, source/version/license labels and Client `--version` matched.
- GitHub package API responses confirmed all six destinations were **private**. Existing source images were checked before publication. No repository visibility or package visibility setting was changed.
- The source/package artifact and image record were downloaded. `verifyRelease` and `verifyImageRecord` matched the full commit/version; the file and image-record checksum inventories passed.

## Immutable image references

The package prefix is `ghcr.io/ddussi/lotur-<target>`. These references remain private and are recorded as evidence, not anonymous installation links.

| Target | SHA-256 digest |
| --- | --- |
| `gateway` | `816db89fa26c23aa34344fe6c4e55ad0f244b473b9039db7a3f17153e0102f2e` |
| `admin-cli` | `8194e063de994c15cc0f71b060a7e1fb318736035f6cda13ccd893cad14d656c` |
| `client` | `e50bac7ac4870382e2b9953e0cf03644329a515967f32b9eb049a62064c2e726` |
| `canary-check` | `ca38a51d508e854bdaa35f7e214b937e3a984f733503b4fd6ce788da75dfec10` |
| `db-backup` | `f6a656802e3af93117f1558608dc10a9555beb669514a596239c2b565e02517f` |
| `db-restore` | `ca4aa93611087c7d924d56989e3692d4d9a95995d850208f27c9b8df3e1cf95b` |

The candidate tag is `candidate-509667ea2129e25665262289db3c8915a9cf4b46-34258812926-1`. The CI artifacts have a seven-day retention period; retain reviewed copies privately for release approval. Registry image digests, not this tag or an expired artifact URL, identify these image contents.

## Issues resolved during this check

- A Vite browser run timed out waiting for a source edit to appear. The fixture previously waited only for page interaction before editing. The test now explicitly waits for the same-host Vite connection frame, then an update frame and the updated DOM. Three macOS repeats and subsequent Linux full gates passed. The original connection race is an inference; the original failure trace was not retained as a public artifact.
- The package REST response omitted `repository` even though the signed-in package UI displayed the linked repository. A read-only inventory confirmed this response shape. The policy now checks owner/name/visibility and the existing image's actual source label by digest; it still rejects a different source. No check was replaced with a hardcoded assumption about visibility.
- Replaced an initial media recording that included loading frames. The final 15.72-second recording starts after authentication and page load; its start, middle and end frames and three screenshots were visually inspected. Only the opening loading interval was trimmed. Synthetic developer actions occur in a separate browser, and no password entry is recorded. The [media index](../media/README.md) documents regeneration.

Actual DB restoration, compatibility of the rollback image, the refreshed base images and the final hosted HTTPS gate remain required by the [alpha plan](../open-source-alpha-plan.md).
