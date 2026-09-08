# Runtime notice inventory — 2026-09-09

The planned `v0.1.0-alpha.1` is still a private candidate. This report records which redistribution notices are included in its images. It is not a legal certification or a security-vulnerability scan.

## Findings and changes

The PostgreSQL backup and restore targets copied the Node.js executable from the Node base image but omitted `/usr/local/LICENSE`. The [Dockerfile](../../Dockerfile) now copies that original file alongside the executable. In the local candidate it contains 157,609 bytes, SHA-256 `5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace`; its bytes are identical across all six targets. Node reports `v24.20.0` in those images. The project MIT license remains at `/app/LICENSE`.

The four application targets include 27 runtime npm packages. Their metadata declares 23 MIT and four ISC licenses; those declarations do not describe the entire image or every vendored component. The inventory includes nested notice files, such as Argon2's bundled implementation notice, as well as the top-level package notice.

| Notice location | Packages | Verification |
| --- | --- | --- |
| Standalone upstream files | 24 | Readable nonempty license/copying files, installed version versus runtime lockfile, content hashes |
| Complete MIT text in upstream README | `pg-types@2.2.0`, `pgpass@1.0.5` | Reviewed README bytes pinned by SHA-256; both original copyright notices and permission text are already present |
| Upstream MIT metadata plus explicit redistribution notice | `@epic-web/invariant@1.0.0` | Exact package/README hashes, declared author/license and source commit, separately identified standard MIT terms |

`@epic-web/invariant` is installed through `argon2 → cross-env`. Its [npm metadata](https://registry.npmjs.org/@epic-web%2finvariant/1.0.0) identifies commit `547be2246d3c39f8ca44dd0502b1aa70bf4378af`; that [source tree](https://github.com/epicweb-dev/invariant/tree/547be2246d3c39f8ca44dd0502b1aa70bf4378af) and the published tarball contain no standalone license file. Its package metadata and README declare MIT, and its metadata names Kent C. Dodds as author. The added [redistribution notice](../../third-party-notices/epic-web-invariant-1.0.0.txt) states those facts, includes standard MIT terms, and explicitly distinguishes this supplied notice from an upstream-authored file. No copyright year is inferred. The source package and its declarations are preserved.

The application images contain 88 installed Debian packages; the PostgreSQL tool images contain 144. Each has a readable `/usr/share/doc/<package>/copyright` entry, including entries resolved through the distribution's symlinks. Shared license texts in `/usr/share/common-licenses` are retained and inventoried. These notices retain their own licenses; the project's MIT label does not relicense the OS or third-party components.

## Execution and scope

The first complete inventory passed against all six locally built `linux/arm64` images from the `95820ae` application baseline plus this notice change. The [inspector](../../scripts/inspect-image-notices.mjs) checks the exact source revision, inspects each local immutable image ID, and runs its [probe](../../scripts/image-notices-probe.mjs) with no network and a read-only filesystem. It verifies the project license against the checkout and the common Node notice across targets, and checks supplied redistribution notices against their source bytes.

The output contains image IDs/platforms, package names/versions, container-local notice paths and hashes. It does not contain environment variables, credentials, host paths, DB data or full third-party source text. Reproduction is in [Contributing](../../CONTRIBUTING.md#exercise-backup-and-restoration).

CI now requires this inventory before database restoration and release-file generation. The manual candidate job repeats it on the images pulled by registry digest and retains a separate `image-notices-published-<sha>-<run>-<attempt>` artifact. Its first updated Linux/registry result is pending. The older `509667e` registry candidate predates both the PostgreSQL 17.11 update and these notice corrections and must not be promoted as the final release.
