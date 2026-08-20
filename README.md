# Review Tunnel

로컬 개발 서버의 HTTP, streaming/SSE와 WebSocket을 인증된 사내 검토자에게 임시 공유하는 도구다.

## 개발 환경

- Node.js 24 이상
- TypeScript 5.9 이상

## 명령

```bash
npm test
npm run typecheck
npm run build
npm run check
npm run admin -- migrate
```

## 격리 POC 실행

인증과 TLS가 없는 Phase 1 POC이므로 기본값은 loopback에서만 실행된다.

```bash
npm run dev:gateway
npm run dev:client -- http://127.0.0.1:3000
```

Client가 출력한 `http://<tunnel-id>.localhost:8787/` 주소로 접속한다. 환경 설정 예시는 [`.env.example`](.env.example)에 있다.

제품 범위와 보안 기준은 [`docs/review-tunnel-plan.md`](docs/review-tunnel-plan.md)를 따른다. 현재 Carrier는 정식 v1이 아니라 격리 POC 전용 `review-tunnel.poc.1`이다.

구현·검증 범위와 Phase 2 잔여 항목은 [`docs/poc-status.md`](docs/poc-status.md)에 기록한다.

## 내부 계정 모드

`DATABASE_URL`, `CONTROL_HOST`, `AUTH_SESSION_HMAC_KEY`를 함께 설정하면 Gateway가 내부 계정 인증 모드로 시작한다. 최초 관리자는 Linux 서버 CLI에서 만들고 이후에는 control host의 `/admin/users` 웹 UI에서 계정을 관리한다. 공개 회원가입은 없다.

운영 절차는 [`docs/internal-account-operations.md`](docs/internal-account-operations.md)와 [`docs/linux-deployment.md`](docs/linux-deployment.md)를 따른다. TLS·Ingress와 파일럿 인수 기준이 끝나기 전에는 인터넷에 공개하지 않는다.
