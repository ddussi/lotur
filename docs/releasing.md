# Release procedure

This is a maintainer procedure, not a record that a release has been published. The alpha can be built from source as Docker targets, a [standalone Client archive](client-installation.en.md), and Vite/Next integration archives. The root, Gateway, and Client remain `private` in npm metadata. Local archive installation and real consumer behavior are tested; this is not a record of npm publication.

## Prepare the candidate

The planned first tag is `v0.1.0-alpha.1`; it has not been published. Root/workspace manifests, internal workspace references, both lockfiles, and the Docker runtime version must agree. Run `npm run check:release-version` after changing them. Historical validation records keep the version they actually tested.

1. Select the final source revision and intended version. Keep root/workspace versions and the lockfile consistent. Do not reuse a version tag for different contents.
2. Update [CHANGELOG.md](../CHANGELOG.md), both READMEs, and any affected setup instructions. Describe implemented features separately from the roadmap.
3. Confirm [LICENSE](../LICENSE) and package license metadata agree. Preserve third-party licenses and required notices in distributions.
4. Set up a working private security reporting channel on the actual hosting repository and confirm [SECURITY.md](../SECURITY.md) describes how users can reach it.
5. Review the source, examples, artifacts, and Git history for private endpoints, account exports, credentials, and machine-specific paths. Ignoring a file does not remove it from Git history. If publishing a source snapshot without history, enumerate tracked and intended new source files; exclude `.git`, dependencies, build/test output, secrets, and running fixtures.

## Validate

- Run the full suite against an isolated PostgreSQL database using [CONTRIBUTING.md](../CONTRIBUTING.md), with no unexpected skips.
- Run `npm run pack:client`, and pack both integration workspaces. Verify that their archives include the required compiled code, declarations where applicable, and licenses. The script suite checks offline Client installation and integration imports outside this monorepo; the demo suite checks the installed Client against a real Gateway, and the framework suite installs integration archives into its apps.
- Audit production dependencies and complete the six runtime image builds and entrypoint smoke checks defined in [.github/workflows/ci.yml](../.github/workflows/ci.yml).
- For hosted releases, use a candidate Gateway and the real DNS/TLS/proxy route. Run the canary, record its result, approve that exact deployment identity, and perform [public browser tests](public-path-testing.md) with dedicated accounts.
- Record versions, platform, image/config identities, results, and untested limits. Publish anonymized evidence; keep deployment-specific secrets and endpoints in private operations records.
- Verify backup restoration, key rotation, resource limits, and rollback for the environment being promoted. Application test success alone does not complete operational acceptance.

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

This command does not create a tag, publish a release, push an image, or deploy a Gateway. The six image targets and planned `linux/amd64` image platform are listed in the manifest; their actual publication digests belong to the separate image-release record. A package candidate without that record and the required operational validation is not a completed release.

## Publish

Review the final diff, create the version tag and release notes, and distribute the source and any explicitly supported images. Include the license and validation scope. Choose the destination repository/registry and credentials at publication time; this project does not prescribe a maintainer-owned domain or account.

For an image or Ingress change, recalculate the configuration digest and repeat canary recording and separate admission approval. Inform users that Gateway restart ends active tunnel URLs. Record observed failures in the changelog and prefer a documented rollback over reusing an old tag with new files.
