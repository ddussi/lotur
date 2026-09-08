# Refreshed private candidate — 2026-09-09

Source `e3b78262d1dcb638a0ae399fc36256e338d7654d`, version `0.1.0-alpha.1`, passed [manual candidate run 34264348717](https://github.com/ddussi/lotur/actions/runs/34264348717). This is a private preparation result, not a release or a production rollout. It supersedes the [earlier PostgreSQL 17.6 candidate](candidate-images-2026-09-09.md) for further acceptance testing.

## Verification

- 74 script, 359 application/PostgreSQL, 19 framework browser, three demo/installed-Client, and one actual-image restoration test passed: 456 total, zero skips. Production npm audit reported zero vulnerabilities.
- PostgreSQL server and backup/restore tools use the pinned 17.11 image. The restored Linux Gateway was the built candidate image. Its synthetic drill passed in 35.0 seconds; the restore command took 429 ms. All eight [restoration checks](database-restore-2026-09-09.md) passed.
- All six `linux/amd64` targets passed entrypoint/configuration checks, private registry publication, digest pulls, image/source/version/platform verification and repeated entrypoint checks.
- The [runtime notice inventory](runtime-notices-2026-09-09.md) passed both for the verification images and again for the registry images. The latter's six references and local image/config identities exactly match `images.json`.
- The downloaded source/package manifest, image record/checksum, published notice inventory and restoration evidence all identify this full source SHA. The source tree is `97f8c4f91d5599a3f3b72f522009e453603dc177`.
- All eight release files passed exact-inventory and checksum validation. The six payload assets total 2,710,764 bytes; the manifest and checksum file are additional metadata.
- Package metadata confirmed private visibility for all six images. The normal production publish and deploy jobs were skipped. The duplicate push run `34264277061` was cancelled because this manual run included the full gate for the same commit.

## Immutable image identities

The prefix is `ghcr.io/ddussi/lotur-<target>@sha256:`. These private references are evidence, not anonymous installation links.

| Target | Digest |
| --- | --- |
| gateway | `677e63614c3ee10961452df1a9d62d64853d49489f8565be41c9b1bcb09eca7f` |
| admin-cli | `43b8a48a5fee355a7e428b1238aa38fb5891c0920ceed439065c9a4036dd63c5` |
| client | `a1a4250f302ba72eb3472dac28aedfc2611b2daafc49d6d5fc8b9448339c1534` |
| canary-check | `030299892f821ffeaf7dd29e9d201e4dfecc18a41bf0a23ebde7acac3778342a` |
| db-backup | `b703cd26117cc1ca1cb5c25a025e2f7739e74885f353d0bea0760dbb7a1254a1` |
| db-restore | `1b71caf16fc738c668434700ac076e83bc88ba80f75723ba7b4801945979d8e3` |

The candidate tag is `candidate-e3b78262d1dcb638a0ae399fc36256e338d7654d-34264348717-1`. Reviewed copies of all five CI artifacts were retained privately before the seven-day Actions retention expires. Checksums establish the selected files' integrity; their trusted provenance is the identified repository run, not the checksum alone.

## Remaining acceptance

Version-tag promotion, isolated real DNS/TLS/proxy acceptance, actual previous-image compatibility and final disclosure/release review remain required. The publication mapping has been prepared; no final version tag or release has been created.

A read-only inspection still found the production Gateway at `41e9570e1e068bea5ba9c4267243cecda7d1be1e`. The isolated HTTPS stage requires new candidate DNS names and a separate certificate. Automatic approval review refused an attempted read/reuse of the existing DNS credential outside its usual certificate-client flow. No such credential read or DNS change was executed. A specific DNS/TLS authorization request is pending; ordinary public DNS checks and all unrelated validation continued. Existing production configuration and data were preserved.
