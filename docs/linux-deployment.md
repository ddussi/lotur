# Linux 서버 배포와 인수 절차

Review Tunnel Gateway는 화면 없는 Linux 서버에서 단일 컨테이너로 실행한다. 관리자는 자신의 PC 브라우저로 `https://<CONTROL_HOST>/admin/users`와 `/admin/operations`에 접속한다.

## 필수 외부 구성

- Node.js 24 실행 이미지 또는 이 저장소의 `Dockerfile`
- PostgreSQL 15 이상. 자동 검증 기준 이미지는 PostgreSQL 17.6이다.
- TLS를 종료하는 승인된 Ingress 또는 Load Balancer
- 콘텐츠용 wildcard DNS·인증서와 다른 사이트 경계의 control DNS·인증서
- 환경별 secret manager와 암호화된 PostgreSQL 백업 저장소
- Prometheus scraper 또는 동등한 보호된 metrics 수집기

예시 경계:

```text
*.preview.example.com    -> Gateway content path
control.example.net      -> 로그인, 관리자 UI, Client API와 Carrier WSS
```

`control.preview.example.com`처럼 control host를 콘텐츠 wildcard와 같은 eTLD+1 아래에 두면 Gateway가 시작을 거부한다. Ingress는 외부 `Forwarded`·`X-Forwarded-*`를 신뢰하지 말고 제거한 뒤 승인된 값만 재작성해야 한다.

## 환경 변수

| 이름 | 기본값·설명 |
| --- | --- |
| `GATEWAY_HOST` | 기본 `127.0.0.1`. 컨테이너는 보통 `0.0.0.0` |
| `GATEWAY_PORT` | 내부 listener, 기본 `8787` |
| `CONTENT_DOMAIN` | scheme·wildcard 없는 콘텐츠 도메인 |
| `CONTROL_HOST` | 콘텐츠와 사이트 경계가 다른 control hostname |
| `DATABASE_URL` | PostgreSQL 연결 문자열. secret manager에서 주입 |
| `AUTH_SESSION_HMAC_KEY` | 32바이트 이상 base64url active key |
| `AUTH_SESSION_HMAC_KEY_PREVIOUS` | 회전 overlap 동안만 쓰는 이전 key의 쉼표 구분 목록 |
| `AUTO_MIGRATE` | 기본 `true`. 별도 migration job을 쓰면 `false` |
| `GATEWAY_ADMISSION_READY` | 인증 모드 기본 `false`. 후보 public path를 검증할 때만 `true`로 배포 |
| `KILL_SWITCH_ENABLED` | 기본 `false`. `true`면 시작부터 신규·기존 공유를 차단 |
| `METRICS_BEARER_TOKEN` | 32자 이상 별도 token. 없으면 `/metrics`는 404 |
| `MAX_REQUEST_BODY_BYTES` | 기본 16 MiB |
| `MAX_FINITE_RESPONSE_BYTES` | 기본 64 MiB. SSE·WebSocket 누적 크기에는 적용하지 않음 |
| `MAX_CONCURRENT_STREAMS` | Tunnel당 기본 128 |
| `MAX_NEW_STREAMS_PER_MINUTE` | Tunnel당 기본 600 |
| `RESPONSE_HEADER_TIMEOUT_MS` | 기본 10초 |
| `STREAM_INACTIVITY_TIMEOUT_MS` | 기본 120초 |
| `MAX_STREAM_DURATION_MS` | 기본 4시간이며 Session 최대 수명보다 클 수 없음 |
| `HEARTBEAT_INTERVAL_MS` | 기본 15초 |
| `CARRIER_LEASE_MS` | 기본 45초이며 heartbeat보다 커야 함 |
| `AUTHORIZATION_MAX_AGE_MS` | 기본 12시간. 개발자 Carrier와 reviewer Stream 재인가 상한 |
| `REVOCATION_CHECK_INTERVAL_MS` | 기본 5초. 계정 `auth_version` 회수 확인 주기 |

Session 최대 수명 8시간, Stream이 없을 때 유휴 30분, resume 유예 2분은 v1 고정 정책이다. 운영 인증 모드에서 HTTP Cookie를 허용하는 `ALLOW_INSECURE_HTTP_AUTH`는 loopback 통합 테스트 외에는 사용하지 않는다.

HMAC key와 metrics token 생성 예:

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
```

## 배포 전 자동 검증

Node 24에서 다음을 실행한다.

```bash
npm ci
npm run check
npm run test:frameworks
```

`test:frameworks`는 설치된 Chrome에서 Vite 8.2.2와 Next.js 16.3.2·React 19.2.8 fixture를 실제 Tunnel에 연결한다. CI 이미지에는 Chrome을 먼저 설치한다.

PostgreSQL 실연동은 격리된 테스트 DB에서 실행한다.

```bash
docker compose -f compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://review_tunnel_test:local-test-only@127.0.0.1:54329/review_tunnel_test npm run test:postgres
docker compose -f compose.test.yml down
```

이 Compose의 데이터 경로는 tmpfs다. 운영 DB URL을 `TEST_DATABASE_URL`에 넣지 않는다.

## 최초 배포

1. PostgreSQL과 secret을 만들고 `npm run admin -- migrate`를 별도 작업으로 실행한다. Gateway DB 계정에서 DDL 권한을 빼려면 이후 `AUTO_MIGRATE=false`를 쓴다.
2. 최초 관리자와 새 비밀번호를 서버 shell에서 만든다.

```bash
npm run admin -- bootstrap --username admin --display-name "운영 관리자"
npm run admin -- change-password --username admin
```

3. 후보 Gateway를 사용자 트래픽이 없는 target group에 올린다. `/health/live`와 `/health/ready`가 성공하는지 확인한다.
4. Ingress에서 control host HTTP·WSS와 콘텐츠 wildcard의 request streaming·SSE·WebSocket Upgrade를 같은 후보로 보낸다. 동적 Tunnel별 router나 인증서를 만들지 않는다.
5. canary 전용 로컬 origin을 실행하고 인증된 개발자 Client로 공유한다.

```bash
CANARY_ORIGIN_PORT=3900 npm run canary:origin
npm run dev:client -- http://127.0.0.1:3900 \
  --gateway wss://control.example.net/_review-tunnel/carrier \
  --control-url https://control.example.net \
  --username canary-developer
```

6. 별도 `REVIEWER` 계정으로 canary 공유 URL에 로그인해 해당 host의 content session Cookie를 안전한 일회성 실행 환경에 넣는다. Cookie를 shell history, CI log나 ticket에 남기지 않는다.

```bash
CANARY_CONTENT_URL=https://<canary-tunnel>.preview.example.com \
CANARY_SESSION_COOKIE='__Host-rt_session=<opaque-value>' \
npm run verify:public-path
```

이 검사는 미인증 차단, 인증된 marker, 전체 upload 종료 전 request 첫 응답, SSE 첫 event와 WebSocket binary echo를 확인한다. 후보에서 통과한 version·Ingress config digest를 기록한 뒤에만 target group을 승격한다. 실패하면 후보를 승격하지 않고 `GATEWAY_ADMISSION_READY=false` 구성으로 되돌린다.

## 상태와 관측

- `/health/live`: 프로세스 liveness
- `/health/ready`: 인증 저장소를 포함한 instance readiness
- control host `/metrics`: `Authorization: Bearer <METRICS_BEARER_TOKEN>`이 있을 때만 Prometheus 형식 반환
- `/admin/operations`: 현재 kill switch 확인·변경. 관리자 비밀번호 재확인 필요

공용 로그에는 Tunnel ID 대신 프로세스 HMAC으로 익명화한 `tunnelRef`, generation, event와 제한된 reason만 남는다. Ingress·APM·오류 수집기에서도 URL query, Cookie, Authorization, request·response body, Resume secret과 Carrier credential을 수집하지 않는다.

권장 알림 시작점은 admission 0, kill switch 1, activation failure 증가, reconnecting Tunnel 장기 지속, stream rejection 급증과 `/health/ready` 실패다. 정확한 임계치와 보존 기간은 파일럿 트래픽을 기준으로 운영팀이 확정한다.

## HMAC key 회전

1. 새 key를 `AUTH_SESSION_HMAC_KEY`에 넣고 기존 active key를 `AUTH_SESSION_HMAC_KEY_PREVIOUS`에 넣어 maintenance rollout한다. Gateway 재시작은 기존 Tunnel URL을 종료한다.
2. overlap 중 새 로그인·교환·Carrier credential은 새 key로 발급되고 기존 로그인 세션은 이전 key 후보로 검증된다.
3. 로그인 세션 최대 12시간과 시계 오차가 지난 뒤 previous key를 제거한다. 문제가 있으면 active·previous 순서를 되돌려 다시 rollout한다.
4. key 원문이나 key ID를 애플리케이션 로그에 쓰지 않는다.

## PostgreSQL 백업과 복구 훈련

백업은 custom format 임시 파일을 만든 뒤 크기를 확인하고 권한 `0600`으로 바꾼 후 원자 rename한다.

```bash
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npm run backup:postgres -- --output-dir /var/lib/review-tunnel/backups
```

백업을 별도 암호화 저장소로 복제하고 checksum·보존 정책을 적용한다. 복구는 대상 스키마를 지우므로 운영 DB가 아닌 격리 DB에서 먼저 수행한다. 기본 PostgreSQL DB에는 복구할 수 없고 정확한 host·port·DB 확인 문자열이 필요하다.

```bash
RESTORE_DATABASE_URL='postgres://user:password@restore-db.internal:5432/review_tunnel_drill' \
CONFIRM_RESTORE_TARGET='restore-db.internal:5432/review_tunnel_drill' \
npm run restore:postgres -- --input /secure/review-tunnel.dump
```

복구 후 migration 상태, 관리자 로그인, 계정 역할, 감사 이벤트와 새 Carrier credential 발급을 확인한다. 복구 훈련 날짜·RTO·RPO·결과는 백업 파일과 분리된 운영 기록에 남긴다.

## 장애와 rollback

- 가용성 canary 실패: 신규 후보 승격을 중지한다. 기존 Session을 보존해야 하면 기존 인스턴스를 재시작하지 말고 원인 분석 뒤 drain한다.
- 인증 우회 가능성 또는 자격 증명 누출: `/admin/operations`에서 kill switch를 켜 신규 요청·resume·현재 Stream·Carrier를 즉시 종료하고 key·비밀번호를 회전한다.
- Gateway rollback·재시작: 메모리 Registry가 사라져 기존 URL은 복구되지 않는다. 사용자에게 새 공유 명령이 필요함을 공지한다.
- kill switch 해제: 원인 제거와 public-path canary 재통과를 확인하고 관리자 재인증으로 해제한다. 종료된 URL은 되살아나지 않는다.
