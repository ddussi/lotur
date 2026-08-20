# Linux 서버 배포

Review Tunnel Gateway는 화면 없는 Linux 서버에서 실행한다. 관리자는 자신의 PC 브라우저로 `https://<CONTROL_HOST>/admin/users`에 접속한다. 서버 GUI나 원격 데스크톱은 필요하지 않다.

## 필수 외부 구성

- Node.js 24 실행 이미지 또는 이 저장소의 `Dockerfile`
- PostgreSQL 15 이상
- TLS를 종료하는 승인된 Ingress 또는 Load Balancer
- 콘텐츠용 wildcard DNS·인증서와 별도 사이트의 control DNS·인증서
- 환경별 secret manager

예시 도메인은 다음처럼 사이트 경계까지 분리한다.

```text
*.preview.example.com    -> Gateway 콘텐츠 경로
control.example.net      -> 로그인, 관리자 UI, Client API/WSS
```

`control.preview.example.com`처럼 control host를 콘텐츠 wildcard 아래에 두면 Gateway가 시작을 거부한다.

## 환경 변수

| 이름 | 설명 |
| --- | --- |
| `GATEWAY_HOST` | 컨테이너에서는 일반적으로 `0.0.0.0` |
| `GATEWAY_PORT` | 내부 listener 포트, 기본 `8787` |
| `CONTENT_DOMAIN` | scheme·wildcard 없는 콘텐츠 도메인 |
| `CONTROL_HOST` | 콘텐츠 사이트와 분리된 control hostname |
| `DATABASE_URL` | PostgreSQL 연결 문자열. secret manager에서 주입 |
| `AUTH_SESSION_HMAC_KEY` | 32바이트 이상 난수의 base64url 표현. secret manager에서 주입 |
| `AUTO_MIGRATE` | 기본 `true`. 운영에서 migration 작업을 분리하면 `false` |

HMAC key 생성 예:

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
```

## 배포 순서

1. PostgreSQL 백업·복구와 TLS 정책을 먼저 구성한다.
2. 환경 변수와 secret을 주입한다. 기본값에서는 Gateway 시작 시 idempotent migration이 실행된다. 운영 DB 계정의 DDL 권한을 분리하려면 먼저 관리 작업으로 `migrate`를 실행하고 Gateway에는 `AUTO_MIGRATE=false`와 DML 권한만 부여한다.
3. 최초 1회 서버 shell에서 관리자 CLI를 실행한다.

```bash
npm run admin -- bootstrap --username admin --display-name "운영 관리자"
npm run admin -- change-password --username admin
```

운영 컨테이너에서는 같은 이미지로 일회성 관리 작업을 실행한다.

```bash
node dist/apps/admin-cli/src/main.js bootstrap --username admin --display-name "운영 관리자"
node dist/apps/admin-cli/src/main.js change-password --username admin
```

최초 설정 이후에는 `https://<CONTROL_HOST>/admin/users`를 사용한다.

4. Ingress에서 control host의 HTTP·WSS와 콘텐츠 wildcard의 HTTP streaming·WebSocket Upgrade를 같은 Gateway로 전달한다.
5. 외부 HTTP는 HTTPS로 redirect하고 Gateway 내부 포트는 Ingress source에서만 접근 가능하게 제한한다.
6. 인증되지 않은 콘텐츠 요청이 차단되고, 로그인·SSE·WebSocket canary가 통과한 뒤에만 파일럿 사용자를 연다.

## Linux 개발자 CLI

개발자 PC에서 다음처럼 실행한다. 비밀번호는 명령행 인자나 환경 변수로 받지 않는다.

```bash
npm run dev:client -- http://127.0.0.1:3000 \
  --gateway wss://control.example.net/_review-tunnel/carrier \
  --control-url https://control.example.net \
  --content-domain preview.example.com \
  --username developer1
```

CI 등 비대화형 환경은 명시적으로 `--password-stdin`을 사용하지만, 가능하면 장기 비밀번호 대신 향후 service credential 기능을 사용한다.
