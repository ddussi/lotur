# Test your deployed HTTPS Gateway

This suite validates deployed sharing, authentication, and framework behavior. It does not currently exercise review binding, comments, notifications, or review SSE over public HTTPS; the local overlay suite covers those separately.

[한국어 요약](#한국어-요약) · [Setup guide](getting-started.en.md) · [Example results](validation/public-https-2026-09-06.md)

Local tests do not exercise your DNS, certificate, or reverse proxy. Run the following checks through the same public path reviewers use. All example domains and usernames are placeholders; use an installation you operate and dedicated test accounts.

## 1. Verify the synthetic public path

Prerequisites: Node.js 24+, `npm ci`, a configured `CANARY_HOST` and `CANARY_BEARER_TOKEN` on the Gateway, and working DNS/TLS routing. Supply the token privately to the command environment; do not paste its value into shell history or a report.

```sh
CANARY_CONTENT_URL=https://canary.preview.tunnel.example.com \
npm run verify:public-path
```

The command expects `CANARY_BEARER_TOKEN` in its environment. It checks unauthenticated rejection, an authorized response, a response before an upload finishes, incremental SSE delivery, and a WebSocket binary echo. HTTPS certificate verification remains enabled. The synthetic host operates independently of normal tunnels and admission approval.

On success, record the result with `admin record-canary` and separately run `admin approve-admission` for the exact deployment ID and configuration digest, as described in the [setup guide](getting-started.en.md#verify-the-public-path-and-allow-sharing). A failed canary must be recorded as failed and resolved before promotion.

## 2. Verify authenticated browser behavior

Use a Gateway that has passed the canary and whose admission is approved. Build the fixture integration packages, then install Chrome to match the tests:

```sh
npm run build
npx playwright install --with-deps chrome
```

Create three dedicated accounts: `ADMIN`, `DEVELOPER`, and `REVIEWER`. Complete each account's initial password change. The browser test logs in, creates shares, edits temporary local fixtures, and **revokes all sessions belonging to the configured reviewer**. Do not use an account with ongoing reviews. The test needs capacity for one active share at a time.

Save the following JSON outside the repository with mode `600`, replacing all placeholders. The field names must remain as shown. This is an input schema, not a usable credential file.

```json
{
  "controlUrl": "https://control.tunnel.example.com",
  "gatewayUrl": "wss://control.tunnel.example.com/_review-tunnel/carrier",
  "accounts": {
    "admin": {"username": "test-admin", "password": "<admin-password>"},
    "developer": {"username": "test-developer", "password": "<developer-password>"},
    "reviewer": {"username": "test-reviewer", "password": "<reviewer-password>"}
  }
}
```

Keep the control and Gateway host/port identical and use the exact carrier path shown. Never point the credentials at an untrusted endpoint. Export the absolute path to your private JSON file as `PUBLIC_TEST_ACCESS_FILE`, then run from the repository root:

```sh
npm run test:frameworks:public
```

You can restrict a diagnostic run to one framework:

```sh
npm run test:frameworks:public -- vite
npm run test:frameworks:public -- next
```

The test starts the real Vite/Next.js fixtures on local loopback ports and connects through your deployed Gateway. It checks:

| Scope | Checks |
| --- | --- |
| Both frameworks | Developer API authentication, WSS activation, browser login, host-isolated Secure/HttpOnly cookies |
| Vite | Button interaction, HMR, disconnect and authenticated resume preserving the URL |
| Next.js | RSC stream, route handler, Server Action, state-preserving Fast Refresh, client navigation |
| Both frameworks | Administrator revocation, closure of open HMR sockets, rejection of new requests, return to login |

The output identifies a temporary artifact directory with `results.json` and screenshots. Failure output includes diagnostic information. Normal completion closes the test tunnels, logs out the developer API session, stops local framework processes, and removes temporary source copies. A forced process kill can bypass cleanup. Test URLs are not permanent demos.

Keep account JSON and raw browser artifacts private. Before publishing evidence, remove actual hosts, local paths, account names, tokens, and unrelated application data. Remove the temporary credential file when finished. The committed [anonymized JSON](validation/2026-09-06-public-https.json) is an example of a publishable summary.

## Scope of a passing result

A pass establishes behavior for the source, browser, frameworks, and proxy path that were exercised. It does not certify a different CDN/proxy setup, all framework versions, concurrent load, long-term uptime, backup restoration, or a full host reboot. Record those limits and repeat the relevant checks when the runtime image or public path changes.

## 한국어 요약

먼저 자신이 운영하는 서버의 예약 canary 주소에서 HTTP 업로드·SSE·WebSocket을 검사합니다. 성공을 기록하고 같은 배포를 별도로 승인한 뒤, 전용 관리자·개발자·검토자 계정으로 브라우저 검사를 실행합니다.

계정 JSON은 저장소 밖에 권한 `600`으로 보관하고, `PUBLIC_TEST_ACCESS_FILE`에 그 절대 경로를 지정합니다. `npm run test:frameworks:public`이 실제 Vite·Next.js 앱을 실행해 로그인·화면 갱신·연결 복구·세션 종료를 확인합니다. **검토자 계정의 모든 로그인 세션을 종료하므로 평소 사용하는 계정으로 검사하지 않습니다.**

검사 주소는 끝나면 닫힙니다. 보고서에 실제 도메인이나 계정 파일을 붙이지 말고 버전·통과 항목·미검증 범위만 익명화해 기록합니다.
