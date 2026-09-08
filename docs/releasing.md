# Release procedure

This is a maintainer procedure, not a record that a release has been published. The alpha can be built from source as Docker targets, a [standalone Client archive](client-installation.en.md), and Vite/Next integration archives. The root, Gateway, and Client remain `private` in npm metadata. Local archive installation and real consumer behavior are tested; this is not a record of npm publication.

## Prepare the candidate

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

## Publish

Review the final diff, create the version tag and release notes, and distribute the source and any explicitly supported images. Include the license and validation scope. Choose the destination repository/registry and credentials at publication time; this project does not prescribe a maintainer-owned domain or account.

For an image or Ingress change, recalculate the configuration digest and repeat canary recording and separate admission approval. Inform users that Gateway restart ends active tunnel URLs. Record observed failures in the changelog and prefer a documented rollback over reusing an old tag with new files.
