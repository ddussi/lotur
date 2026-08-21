# Review Tunnel

로컬 개발 서버의 HTTP, streaming/SSE와 WebSocket을 인증된 사내 검토자에게 임시 공유하는 도구다.

## 개발 환경

- Node.js 24 이상
- TypeScript 5.9 이상

## 명령

```bash
npm test
npm run test:frameworks
npm run typecheck
npm run build
npm run check
npm run check:mvp
npm run admin -- migrate
```

`npm run check`는 87개 단위·통합 테스트 중 PostgreSQL 환경이 필요한 1개를 조건부로 실행한다. `npm run test:frameworks`는 설치된 Chrome에서 고정 버전 Vite 8.2.2와 Next.js 16.3.2의 HMR·Fast Refresh 경로를 별도로 검증한다.

## 로컬 격리 실행

환경 변수 없이 실행하면 인증과 TLS가 없는 개발 모드이므로 Gateway는 loopback에만 바인딩된다. Carrier 자체는 정식 `review-tunnel.v1` 활성화·heartbeat·resume 계약을 사용한다.

```bash
npm run dev:gateway
npm run dev:client -- http://127.0.0.1:3000
```

Client가 출력한 `http://<tunnel-id>.localhost:8787/` 주소로 접속한다. 환경 설정 예시는 [`.env.example`](.env.example)에 있다.

제품 범위와 보안 기준은 [`docs/review-tunnel-plan.md`](docs/review-tunnel-plan.md)를 따른다.

구현·검증 범위와 외부 환경에서 남은 인수 작업은 [`docs/poc-status.md`](docs/poc-status.md)에 기록한다.

## 내부 계정 모드

`DATABASE_URL`, `CONTROL_HOST`, `AUTH_SESSION_HMAC_KEY`를 함께 설정하면 Gateway가 내부 계정 인증 모드로 시작한다. 최초 관리자는 Linux 서버 CLI에서 만들고 이후에는 control host의 `/admin/users` 웹 UI에서 계정을 관리한다. 공개 회원가입은 없다.

운영 절차는 [`docs/internal-account-operations.md`](docs/internal-account-operations.md)와 [`docs/linux-deployment.md`](docs/linux-deployment.md)를 따른다. TLS·Ingress public-path canary, secret manager와 PostgreSQL 복구 훈련을 실제 환경에서 통과하기 전에는 인터넷에 공개하지 않는다.

## 운영 검증 도구

```bash
npm run canary:origin
npm run verify:public-path
npm run backup:postgres -- --output-dir /secure/backup/path
npm run restore:postgres -- --input /secure/backup/path/review-tunnel.dump
```

각 명령에 필요한 환경 변수와 안전한 실행 순서는 [`docs/linux-deployment.md`](docs/linux-deployment.md)에 있다.
