# Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. English and Korean are both accepted. The current alpha implements authenticated sharing and contextual reviews. Per-project authorization remains planned work.

## Get a development environment

Use Node.js 24+, npm, Python 3.9+ (`python3`), and a source checkout. Deployment script checks run on Linux or macOS; use WSL for those checks on Windows. Run commands from the repository root. For browser tests, install **Google Chrome**, matching `channel: "chrome"` in the Playwright configuration. On Linux, installation of browser system dependencies may require administrator privileges.

```sh
npm ci
npx playwright install --with-deps chrome
```

Local unit/script checks without an external database:

```sh
npm run check
```

This runs linting, type checking, architecture boundaries, build, script tests, and unit/integration tests. PostgreSQL integration tests explicitly skip when `TEST_DATABASE_URL` is absent; this is not the full validation gate.

## Run the full suite

Use Docker Compose to start the isolated PostgreSQL 17.11 fixture. It uses a temporary filesystem and the following credentials are **test-only defaults**. Do not point these tests at a database whose data you need to retain.

```sh
docker compose -f compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://review_tunnel_test:local-test-only@127.0.0.1:54329/review_tunnel_test npm run check:mvp
docker compose -f compose.test.yml down
```

Always stop the fixture after testing, including after a failed run. `check:mvp` adds authenticated Vite/Next.js browser tests, a Next.js production build check, and review overlay scenarios to `check`. Tests create disposable fixture copies; do not edit a running `.runtime-*` directory as a source change.

| Command | Use |
| --- | --- |
| `npm run check:style` | JavaScript and TypeScript lint rules |
| `npm run typecheck` | TypeScript types |
| `npm run check:boundaries` | Package dependency boundaries |
| `npm run test:scripts` | Deployment, backup, canary, and other script behavior |
| `npm test` | Application and package tests |
| `npm run test:postgres` | Real database tests; requires an isolated `TEST_DATABASE_URL` |
| `npm run test:frameworks` | Authenticated Vite/Next.js, production HTML, and review overlay tests |
| `npm run test:demo` | Real demo lifecycle and two-user reviews; externally installed Client terminal/sharing/reconnection/cleanup checks. Requires local Docker Engine 28+ / Compose, Chrome, and Python 3.9+ on Linux/macOS |
| `npm run test:restore` | Back up real synthetic reviews, restore into an empty isolated DB, recreate restricted DB permissions, and continue authenticated reviews. Requires the locally built images described below |
| `npm run test:frameworks:public` | Opt-in tests against your own deployed HTTPS Gateway |

Run `npm run build` before invoking browser suites directly; their fixtures import the compiled integration packages.

The public suite creates shares and revokes a reviewer's sessions. Configure dedicated accounts using the [public-path testing guide](docs/public-path-testing.md); it is not part of the default CI run.

`test:demo` creates its own isolated Compose projects on dynamically assigned loopback ports and deletes their test data afterward. It does not use `TEST_DATABASE_URL` or your `.review-tunnel-demo` directory. Its private browser traces can contain disposable login credentials; do not publish them without review.

CI runs the full database-backed gate, the local demo suite, audits production dependencies, and builds/smoke-checks the six production Docker targets. It then restores synthetic reviews using those exact images before creating release files. A local source check does not substitute for those image checks.

## Exercise backup and restoration

Build all six images from the checkout being tested, with its source revision label. Restoration uses four of them; the notice inventory checks all six. Use a clean checkout when recording release evidence. Both checks verify the label and run each inspected image by its local immutable ID:

```sh
restore_revision=$(git rev-parse HEAD)
for target in gateway admin-cli client canary-check db-backup db-restore; do
  docker build --target "$target" \
    --label "org.opencontainers.image.revision=${restore_revision}" \
    -t "review-tunnel-${target}:restore-check" . || exit 1
done
npm run build
npm run test:restore
node scripts/inspect-image-notices.mjs --tag restore-check --output dist/image-notices-local.json
```

The test owns a separate demo database, an empty restore database, a private backup volume and an isolated network. It does not use an existing demo state or `TEST_DATABASE_URL`; its own containers, dump and data are deleted in cleanup. It compares every table and sequence before allowing new writes, repeats migration twice, and checks fresh authentication, role restrictions, inbox recipients, a new canary/admission identity, replies, re-review and anchored pins in a new share.

On Linux, the restored Gateway runs in the candidate image using host networking while binding only to loopback. On macOS, it runs the corresponding source on the host; migration, backup and restore still use the images. This does not establish Docker Desktop host-network support or an HTTPS/previous-image rollback result. CI requires the Linux image path. Only the sanitized `restore-validation.json` is uploaded; dumps, private runner logs, browser traces, sessions and account records must stay private.

The notice inventory records Node.js, project, installed npm package and Debian copyright-file hashes. Existing output is preserved; choose a new `--output` path for a repeat. For registry candidates, pull all six recorded images first and use `--record <images.json>` instead of `--tag`. See the [notice inventory findings](docs/validation/runtime-notices-2026-09-09.md) for the upstream README and metadata cases. This is an inventory of included notices, not a vulnerability scan or a legal certification.

## Propose a change

The [contributor roadmap](docs/roadmap.md) lists small documentation, example and test tasks with suggested completion checks. These are proposed scopes, not reserved assignments or a promise of delivery dates. Check existing issues and pull requests before starting duplicate work.

Open an issue first for a protocol change, new authentication model, or substantial product feature so its scope can be discussed. Small bug fixes and documentation corrections can go directly to a pull request.

- Describe the user-visible problem and the final behavior.
- Keep a pull request focused and follow existing TypeScript and package boundaries.
- Add a regression test for a behavior bug, especially authentication, reconnection, streaming, or shutdown ordering.
- Update English and Korean README descriptions together when behavior or setup changes. Mark proposed features as planned.
- Record which relevant checks passed, failed, or were not run. For documentation-only changes, check links and commands instead of rerunning unrelated suites.
- Use reserved example domains and synthetic data. Do not commit real endpoints, credentials, account exports, private logs, browser traces, or local machine paths.

Use [SECURITY.md](SECURITY.md) for vulnerabilities. Ordinary bug reports should include the tested commit/version, OS, Node/browser/framework versions, a minimal reproduction, and sanitized output. Do not test installations you do not operate or have permission to assess.

## License

Contributions are made under this project's [MIT license](LICENSE). Include code and assets you have the right to contribute, and preserve required third-party notices. Dependencies retain their own licenses.

## 한국어 안내

버그 제보·문서 수정·기능 개선은 한국어로 작성해도 됩니다. 위 명령은 저장소 루트에서 Node.js 24 이상으로 실행합니다. 배포 스크립트 검사에는 Python 3.9 이상과 Linux·macOS 환경이 필요하며 Windows에서는 WSL을 사용합니다. 전체 검사에는 임시 PostgreSQL과 Chrome이 필요합니다. DB 없이 통과한 결과를 전체 검사 통과로 적지 말아 주세요.

PR에는 문제, 수정 후 동작, 재현 방법, 실행한 검사를 적습니다. 실제 도메인·계정·비밀번호·개인 서버 정보는 예시로 사용하지 않습니다. 취약점의 상세 내용은 공개 이슈에 올리지 말고 [보안 제보 절차](SECURITY.md)를 따릅니다.
