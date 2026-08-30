# Public HTTPS validation — 2026-09-06

An operator-controlled deployment was tested through real DNS and valid HTTPS, using a production Gateway Docker image. This public report deliberately omits deployment endpoints, account names, private server paths, network addresses, certificate identifiers, and image/configuration identities. It is evidence of one tested environment, not a hosted service offer or production certification.

## Environment

| Component | Tested configuration |
| --- | --- |
| Client and browser runner | macOS, Node.js 24.12.0, Chrome |
| Gateway | Ubuntu x86_64, image built from the repository's pinned Dockerfile |
| Database | PostgreSQL 17.6, separate runtime DML role |
| HTTPS reverse proxy | Nginx Proxy Manager 2.15.0 |
| DNS and TLS | DNS-only records, valid control/wildcard certificate, no CDN proxy in the request path |
| Frameworks | Vite 8.2.2; Next.js 16.3.2 with React 19.2.8 |

## Results

| Check | Observed result |
| --- | --- |
| Production Gateway image build | Passed on x86_64 |
| Public canary | Unauthenticated rejection, authorized request, upload streaming, SSE, and binary WebSocket echo passed |
| Deployment admission | Canary result recorded, then separately approved for the tested deployment identity |
| Browser authentication | Developer API login and WSS activation; reviewer login with isolated Secure/HttpOnly cookies passed |
| Vite | Button interaction, HMR, and same-URL authenticated reconnect passed |
| Next.js | RSC stream, route handler, Server Action, state-preserving Fast Refresh, navigation passed |
| Revocation | Both frameworks lost existing HMR connections; subsequent requests returned 401 and navigation returned to login |
| Gateway restart | Readiness recovered; persisted accounts and approval permitted both framework suites to pass again |
| Local browser regression | Two tests passed after the fixture correction below |

The public tests exposed a Next.js fixture timing issue: the server-rendered button was visible before its client click handler was attached. The handler was absent at the failing click and present when a later click worked. The fixture now disables interactive buttons until hydration completes. The public and local tests then passed; the failure was not bypassed by ignoring an assertion or adding a fixed sleep.

Reproduce using [public-path-testing.md](../public-path-testing.md). The [machine-readable summary](2026-09-06-public-https.json) retains the passed checks without deployment-specific identifiers. Test-created URLs were closed after each run.

## Limits

- This was a small functional validation, not a sustained or concurrent load test.
- External backup/restore, key rotation, alert response, and a full host reboot were not exercised in this public deployment run.
- The path did not traverse a CDN proxy. A different proxy path requires its own canary and browser verification.
- Only the Gateway production image was built in this deployment run. The six-target image matrix is a separate CI gate.
- Passing results for these versions do not establish compatibility with every browser or framework version.
- Accounts and operational state survived Gateway restart; active tunnel routes do not survive that restart.

## 한국어 요약

실제 HTTPS·Ubuntu·PostgreSQL·운영 이미지 환경에서 로그인, Vite·Next.js 기능, 연결 복구, 세션 종료와 재시작 후 저장 상태 유지를 확인했습니다. 개인 도메인·서버·계정 정보는 공개 기록에서 제외했습니다.

소규모 기능 검사가 통과한 것이며 장기간 부하, 외부 백업 복구, 서버 전체 재부팅이나 다른 프록시 조합까지 검증한 것은 아닙니다. 설치자는 자신의 환경에서 같은 절차를 수행해야 합니다.
