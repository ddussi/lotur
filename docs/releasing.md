# Release procedure

This is a maintainer procedure, not a record that a release has been published. The alpha can be built from source as Docker targets, a [standalone Client archive](client-installation.en.md), and Vite/Next integration archives. The root, Gateway, and Client remain `private` in npm metadata. Local archive installation and real consumer behavior are tested; this is not a record of npm publication.

## Prepare the candidate

The planned first tag is `v0.1.0-alpha.1`; it has not been published. Root/workspace manifests, internal workspace references, both lockfiles, and the Docker runtime version must agree. Run `npm run check:release-version` after changing them. Historical validation records keep the version they actually tested.

1. Select the final source revision and intended version. Keep root/workspace versions and the lockfile consistent. Do not reuse a version tag for different contents.
2. Update [CHANGELOG.md](../CHANGELOG.md), both READMEs, and any affected setup instructions. Describe implemented features separately from the roadmap.
3. Confirm [LICENSE](../LICENSE) and package license metadata agree. Preserve third-party licenses and required notices in distributions.
4. Prepare the exact private security reporting address in [SECURITY.md](../SECURITY.md). GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) is a public-repository feature: enable and verify it during approved publication before announcing the release.
5. Review the source, examples, artifacts, and Git history for private endpoints, account exports, credentials, and machine-specific paths. Ignoring a file does not remove it from Git history. If publishing a source snapshot without history, enumerate tracked and intended new source files; exclude `.git`, dependencies, build/test output, secrets, and running fixtures.

## Validate

- Run the full suite against an isolated PostgreSQL database using [CONTRIBUTING.md](../CONTRIBUTING.md), with no unexpected skips.
- Run `npm run pack:client`, and pack both integration workspaces. Verify that their archives include the required compiled code, declarations where applicable, and licenses. The script suite checks offline Client installation and integration imports outside this monorepo; the demo suite checks the installed Client against a real Gateway, and the framework suite installs integration archives into its apps.
- Audit production dependencies and complete the six runtime image builds and entrypoint smoke checks defined in [.github/workflows/ci.yml](../.github/workflows/ci.yml).
- Inspect installed package versions and included notices with `node scripts/inspect-image-notices.mjs --tag ci`. Preserve the resulting inventory with the candidate evidence. The check uses isolated read-only containers; it does not substitute for a vulnerability audit. [Known notice locations](validation/runtime-notices-2026-09-09.md) distinguish upstream license files, README text and an explicitly supplied redistribution notice.
- Prepare the existing deployment's rollback and post-rollout checks. A separate development server, DNS records and certificate are outside this alpha preparation. After an approved rollout, use the existing HTTPS/proxy route, record its canary result, approve that exact deployment identity, and perform [public browser tests](public-path-testing.md) with dedicated accounts. Record this separately from the isolated local/CI results.
- Record versions, platform, image/config identities, results, and untested limits. Publish anonymized evidence; keep deployment-specific secrets and endpoints in private operations records.
- Verify backup restoration and preserve the existing deployment's key-rotation and resource-limit controls. Do not claim previous-image rollback compatibility without testing it; for a schema-changing rollout, establish compatibility or prepare recovery from a quiesced backup into a replacement database.

## Build and inspect candidate files

From a clean committed checkout with dependencies installed:

```sh
npm run pack:release
```

The command checks versions, captures the exact commit/tree, and writes a new `dist/releases/<version>-<commit-prefix>/` directory. It contains the Client, Vite, and Next archives; a `git archive` source tarball; LICENSE; CHANGELOG; `release-manifest.json`; and `SHA256SUMS`. Existing output is preserved, and a dirty or changing worktree is rejected. Use `-- --output-dir <new-directory>` for another location outside the tracked source tree.

```sh
npm run verify:release -- /path/to/candidate --commit <full-40-character-commit>
```

Verification requires the exact file inventory and checks both manifest sizes/hashes and SHA256SUMS. Compare the manifest's commit with the selected source and successful CI run. These checks establish internal file integrity and the expected recorded revision; checksums alone do not authenticate an unknown download source.

After the full CI gate and six image checks, CI builds the same candidate files and retains them for seven days in an artifact named for its source SHA and attempt. Pull-request checks do not upload a candidate. Only these generated distribution files are uploaded, not browser traces, account exports, or test logs. Candidate files are available to repository readers; the repository remains private during this preparation. The [GitHub artifact documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data) describes access and retention.

After downloading the CI artifact, pass its `<version>-<commit-prefix>/` child directory to `verify:release`, not the parent download directory.

This command does not create a tag, publish a release, push an image, or deploy a Gateway. The six image targets and planned `linux/amd64` image platform are listed in the manifest; their actual publication digests belong to the separate image-release record. A package candidate without that record and the required operational validation is not a completed release.

## Build candidate images

Run the existing **CI** workflow manually on the selected branch with `candidate_images=true` and `candidate_visibility=private` during private preparation. For example, from an authenticated maintainer checkout:

```sh
gh workflow run ci.yml --ref <candidate-branch> -f candidate_images=true -f candidate_visibility=private
```

The full verification job must pass first. A read-only inventory records only the selected package identities. The separate candidate job checks package ownership and visibility, builds all six targets for `linux/amd64`, checks entrypoints, pushes unique `candidate-<commit>-<run-id>-<attempt>` tags, pulls each image by digest, and repeats the entrypoint checks. It verifies source/version/license labels and the image architecture, then inspects the included runtime notices. The seven-day `release-images-<commit>-<run-id>-<attempt>` artifact contains `images.json` and its checksum in a candidate subdirectory. The separate `image-notices-published-<commit>-<run-id>-<attempt>` artifact records notices in those pulled images. Pair them with the successful run's source/package artifact and compare their exact source SHA and version.

Existing candidate tags are not overwritten. A retry uses a new Actions attempt and therefore a new tag. A partial failure can leave candidate images in the registry, but does not produce a complete image record or release. Existing final version tags and current deployment SHA tags are untouched. This mode also skips the normal production publish/deploy jobs when manually run on `main`; normal `main` pushes retain the existing automatic deployment behavior.

The candidate job uses its repository-scoped token, without production environment secrets. New packages must first be private. Existing packages must have the selected owner, name and visibility; their most recent image is pulled by digest and must identify the current repository in its source label before any candidate build. Package REST responses can omit repository-link metadata, so the script checks the actual image source as well as destination identity. Access errors stop the build. Before choosing `public` for an already-public package, review the destination and approve its publication. The job does not change visibility. GitHub documents [package access and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility) separately from [GHCR publication and digest pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The initial published image platform will be `linux/amd64` only after an actual successful candidate run. Native macOS source and package checks do not establish published `linux/arm64` images. Database restoration must identify its tested images. Hosted acceptance after an approved rollout must record the actual deployed immutable references; entrypoint smoke checks alone do not establish either result.

## Publish

Review the final diff and the [first alpha release notes](releases/0.1.0-alpha.1.md). Retain all candidate artifacts privately before the seven-day expiry. The image candidate's `SHA256SUMS` is separate from the source/package file with the same name; keep their directories separate and name the uploaded image checksum `images-SHA256SUMS`. Confirm the source/package manifest, image record, notice inventory, restoration evidence and version mapping all name the selected commit. Preserve the user's approval for the exact publication scope.

### Apply version tags without rebuilding

The candidate CI rehearses all six version tags with Docker's `imagetools create --dry-run --prefer-index=false`. The [Release image tags workflow](../.github/workflows/release-image-tags.yml) requires a successful manual CI candidate run from its exact checked-out commit, verifies the downloaded file manifests, pulls the six recorded digests, and checks their source/version/platform/config identities. Its default is another dry run:

```sh
gh workflow run release-image-tags.yml --ref <selected-branch-or-tag> \
  -f candidate_run=<successful-candidate-run-id> -f publish=false
```

GitHub must first have the workflow on the default branch. After publication approval and the selected source is on `main`, use `publish=true` to apply `v0.1.0-alpha.1` to those same manifests. No build, visibility change or deployment occurs in this workflow. It uses the repository's normal token and no production secrets. The recorded result distinguishes a dry run from publication.

Every destination is inspected before the first write. A different existing digest stops the operation; a matching tag is retained. After each write, the registry digest must exactly match the candidate. A partial failure can leave some version tags in place: inspect the result and rerun the same candidate to complete missing tags, never choose new contents for that version. The workflow serializes its own runs; avoid concurrent manual registry writes. Docker documents [manifest copying and dry runs](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/).

### Create the GitHub prerelease

After the approved `main` rollout passes the existing HTTPS checks, create the version tag at the exact candidate commit (never move an existing tag). Use the verified source/package files, `images.json`, `images-SHA256SUMS`, `release-image-tags.json`, the sanitized notice inventory and restoration evidence as release assets. Keep account exports, DB dumps and raw operation logs private. Prepare notes in a file and create a draft with `gh release create v0.1.0-alpha.1 --verify-tag --prerelease --draft --notes-file <reviewed-notes-file> <explicit-asset-paths>`; inspect its full asset inventory before publishing it.

Apply the approved repository/package visibility settings, enable private vulnerability reporting, and check access without GitHub or Docker credentials. Then publish the reviewed draft and verify the actual Client download/checksum/install/version, all six anonymous digest pulls, the reporting form, and equality of local `main`, remote `main`, release tag and the deployed source revision. If any of these fail, report the incomplete step rather than declaring publication complete. The configured `main` automatic deployment remains separate from image version promotion and release publication.

For an image or Ingress change, recalculate the configuration digest and repeat canary recording and separate admission approval. Inform users that Gateway restart ends active tunnel URLs. Record observed failures in the changelog and prefer a documented rollback over reusing an old tag with new files.
