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
canary.preview.example.com -> 예약된 synthetic public-path canary
control.example.net      -> 로그인, 관리자 UI, Client API와 Carrier WSS
```

`control.preview.example.com`처럼 control host를 콘텐츠 wildcard와 같은 eTLD+1 아래에 두면 Gateway가 시작을 거부한다. Ingress는 외부 `Forwarded`·`X-Forwarded-*`를 신뢰하지 말고 제거한 뒤 승인된 값만 재작성해야 한다.

## 환경 변수

| 이름 | 기본값·설명 |
| --- | --- |
| `GATEWAY_HOST` | 기본 `127.0.0.1`. 컨테이너는 보통 `0.0.0.0` |
| `GATEWAY_PORT` | 내부 listener, 기본 `8787` |
| `CONTENT_DOMAIN` | scheme·wildcard 없는 콘텐츠 도메인 |
| `PUBLIC_CONTENT_ORIGIN` | 외부 검토자에게 표시할 canonical origin. 예: `https://preview.example.com` |
| `CONTROL_HOST` | 콘텐츠와 사이트 경계가 다른 control hostname |
| `DATABASE_URL` | PostgreSQL 연결 문자열. secret manager에서 주입 |
| `AUTH_SESSION_HMAC_KEY` | 32바이트 이상 base64url active key |
| `AUTH_SESSION_HMAC_KEY_PREVIOUS` | 회전 overlap 동안만 쓰는 이전 key의 쉼표 구분 목록 |
| `AUTO_MIGRATE` | 기본 `true`. 별도 migration job을 쓰면 `false` |
| `DEPLOYMENT_ID` | 배포 파이프라인이 발급한 1~128자 release ID |
| `DEPLOYMENT_CONFIG_DIGEST` | image·Ingress·운영 설정 묶음의 `sha256:<64 lowercase hex>` digest |
| `CANARY_HOST` | `CONTENT_DOMAIN` 아래의 예약된 정확한 hostname. Tunnel ID namespace로 사용하지 않음 |
| `CANARY_BEARER_TOKEN` | 32자 이상 synthetic canary 전용 secret. 일반 계정·Cookie와 공유하지 않음 |
| `OPERATIONAL_STATE_POLL_INTERVAL_MS` | PostgreSQL admission·kill switch 동기화 주기, 기본 2초 |
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

인증 모드에서는 `GATEWAY_ADMISSION_READY`와 `KILL_SWITCH_ENABLED` 환경변수를 사용하면 시작을 거부한다. 두 값은 재시작 후에도 유지되고 여러 실행 주체가 같은 결과를 보도록 PostgreSQL에서만 변경한다. 운영 상태 조회가 실패하면 기존 kill switch 값은 유지하되 신규 Session admission은 즉시 닫힌다. 같은 DB의 계정 권한 재검증까지 실패하면 cached allow로 버티지 않고 관련 Carrier·Stream을 fail-closed 종료한다.

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

역할별 image는 같은 소스 revision에서 명시적으로 빌드한다. target을 생략한 기본 image도 Gateway지만 배포 파이프라인에서는 target 이름을 고정한다.

```bash
docker build --target gateway -t registry.example/review-tunnel-gateway:<release> .
docker build --target admin-cli -t registry.example/review-tunnel-admin:<release> .
docker build --target client -t registry.example/review-tunnel-client:<release> .
docker build --target canary-check -t registry.example/review-tunnel-canary:<release> .
docker build --target db-backup -t registry.example/review-tunnel-db-backup:<release> .
docker build --target db-restore -t registry.example/review-tunnel-db-restore:<release> .
```

모든 runtime target은 non-root `node` 사용자로 실행된다. Gateway는 read-only root filesystem, `no-new-privileges`, 명시적인 CPU·memory 제한과 종료 유예를 배포 정의에서 추가한다. Admin CLI와 canary는 상주 service가 아니라 `--rm` one-off job으로 실행하고 Gateway image의 command를 바꿔 재사용하지 않는다.

역할별 실행 형태는 다음과 같다. `<runtime-env>`는 권한 `0600`의 임시 예시일 뿐이며 운영에서는 orchestrator secret injection을 우선한다.

```bash
# 상주 Gateway
docker run --read-only --init --restart unless-stopped \
  --security-opt no-new-privileges --env-file <runtime-env> \
  -p 127.0.0.1:8787:8787 registry.example/review-tunnel-gateway:<release>

# migration·계정·admission·kill switch one-off
docker run --rm -it --env-file <runtime-env> \
  registry.example/review-tunnel-admin:<release> migrate

# public-path canary one-off
docker run --rm \
  -e CANARY_CONTENT_URL=https://canary.preview.example.com \
  -e CANARY_BEARER_TOKEN \
  registry.example/review-tunnel-canary:<release>
```

Linux 개발자가 Client image로 같은 호스트의 로컬 개발 서버를 공유하려면 `--network host`를 사용한다. 사내 컨테이너 정책이 host network를 금지하면 로컬 origin에만 접근 가능한 별도 명시적 network를 만든다.

```bash
docker run --rm -it --network host \
  -e GATEWAY_URL=wss://control.example.net/_review-tunnel/carrier \
  -e CONTROL_URL=https://control.example.net \
  -e CONTENT_DOMAIN=preview.example.com \
  registry.example/review-tunnel-client:<release> \
  http://127.0.0.1:3000 --username developer1
```

PostgreSQL 실연동은 격리된 테스트 DB에서 실행한다.

```bash
docker compose -f compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://review_tunnel_test:local-test-only@127.0.0.1:54329/review_tunnel_test npm run test:postgres
docker compose -f compose.test.yml down
```

이 Compose의 데이터 경로는 tmpfs다. 운영 DB URL을 `TEST_DATABASE_URL`에 넣지 않는다.

## 최초 배포

1. PostgreSQL과 secret을 만들고 Admin CLI image의 `migrate`를 별도 one-off 작업으로 실행한다. Gateway DB 계정에서 DDL 권한을 빼려면 이후 `AUTO_MIGRATE=false`를 쓴다.
2. 최초 관리자와 새 비밀번호를 서버 shell에서 만든다.

```bash
npm run admin -- bootstrap --username admin --display-name "운영 관리자"
npm run admin -- change-password --username admin
```

3. 후보 Gateway를 사용자 트래픽이 없는 target group에 올린다. `/health/live`와 `/health/ready`가 성공하는지 확인한다.
4. Ingress에서 control host HTTP·WSS와 콘텐츠 wildcard의 request streaming·SSE·WebSocket Upgrade를 같은 후보로 보낸다. 동적 Tunnel별 router나 인증서를 만들지 않는다.
5. `CANARY_HOST`의 예약 경로를 실제 DNS·TLS·Load Balancer·Ingress를 통해 검사한다. 이 fixture는 Gateway 자체의 synthetic marker만 사용하며 Tunnel, 일반 사용자 Cookie, Session admission과 kill switch에 의존하지 않는다.

```bash
CANARY_CONTENT_URL=https://canary.preview.example.com \
CANARY_BEARER_TOKEN="$CANARY_BEARER_TOKEN" \
npm run verify:public-path
```

이 검사는 미인증 요청 차단, 인증된 marker, 전체 upload 종료 전 request 첫 응답, SSE 첫 event와 WebSocket binary echo를 확인한다. bearer는 secret manager가 안전한 one-off job에만 주입하며 shell history, CI log, ticket이나 일반 Gateway access log에 남기지 않는다.

6. 검사 결과를 같은 `DEPLOYMENT_ID`·`DEPLOYMENT_CONFIG_DIGEST`에 기록한다. 실패 경로도 반드시 `failed`로 기록하고 후보를 승격하지 않는다.

```bash
npm run admin -- record-canary --as release-admin --result passed \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
```

7. canary 성공 기록만으로 admission은 열리지 않는다. 관리자 또는 승인된 배포 파이프라인이 별도 명령으로 같은 identity를 명시 승인한다. 이 두 명령은 모두 관리자 비밀번호 재확인이 필요하며 자동화에서는 `--password-stdin`과 secret input을 사용한다.

```bash
npm run admin -- approve-admission --as release-admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
npm run admin -- admission-status --as release-admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
```

`admissionReady:true`를 확인한 뒤에만 target group을 사용자 트래픽으로 승격한다. canary가 한 번이라도 실패한 identity는 기존 승인이 제거되므로 새 성공 기록 뒤 다시 명시 승인해야 한다. 다른 배포 identity의 성공·승인은 현재 배포를 자동으로 열지 않는다.

## 상태와 관측

- `/health/live`: 프로세스 liveness
- `/health/ready`: 인증 저장소를 포함한 instance readiness
- control host `/metrics`: `Authorization: Bearer <METRICS_BEARER_TOKEN>`이 있을 때만 Prometheus 형식 반환
- `/admin/operations`: PostgreSQL에 영속되는 현재 kill switch 확인·변경. 관리자 비밀번호 재확인 필요
- `admin admission-status`: 현재 배포의 canary·승인·전역 kill switch와 최종 admission 상태

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

서버에 PostgreSQL client를 별도 설치하지 않을 때는 server와 같은 17.6 client를 고정한 one-off image를 사용한다. mount 디렉터리는 image의 non-root `postgres` 사용자가 쓸 수 있어야 한다.

```bash
docker run --rm \
  -v /var/lib/review-tunnel/backups:/backup \
  -e DATABASE_URL \
  registry.example/review-tunnel-db-backup:<release> --output-dir /backup
```

백업을 별도 암호화 저장소로 복제하고 checksum·보존 정책을 적용한다. 복구는 대상 스키마를 지우므로 운영 DB가 아닌 격리 DB에서 먼저 수행한다. 기본 PostgreSQL DB에는 복구할 수 없고 정확한 host·port·DB 확인 문자열이 필요하다.

```bash
RESTORE_DATABASE_URL='postgres://user:password@restore-db.internal:5432/review_tunnel_drill' \
CONFIRM_RESTORE_TARGET='restore-db.internal:5432/review_tunnel_drill' \
npm run restore:postgres -- --input /secure/review-tunnel.dump
```

```bash
docker run --rm \
  -v /secure:/backup:ro \
  -e RESTORE_DATABASE_URL -e CONFIRM_RESTORE_TARGET \
  registry.example/review-tunnel-db-restore:<release> \
  --input /backup/review-tunnel.dump
```

복구 후 migration 상태, 관리자 로그인, 계정 역할, 감사 이벤트, `rt_operational_controls`, 배포별 canary·admission 기록과 새 Carrier credential 발급을 확인한다. 복구된 kill switch가 원본과 일치하는지 가장 먼저 확인하며, 불명확하면 활성화 상태로 간주해 공유를 차단한다. 복구 훈련 날짜·RTO·RPO·결과는 백업 파일과 분리된 운영 기록에 남긴다.

## 장애와 rollback

- 가용성 canary 실패: 해당 identity에 `record-canary --result failed`를 기록해 신규 admission을 닫고 후보 승격을 중지한다. 기존 Session을 보존해야 하면 기존 인스턴스를 재시작하지 말고 원인 분석 뒤 drain한다.
- 인증 우회 가능성 또는 자격 증명 누출: `/admin/operations`에서 kill switch를 켜 신규 요청·resume·현재 Stream·Carrier를 즉시 종료하고 key·비밀번호를 회전한다.
- Gateway rollback·재시작: 메모리 Registry가 사라져 기존 URL은 복구되지 않는다. 사용자에게 새 공유 명령이 필요함을 공지한다.
- kill switch 해제: 원인 제거, public-path canary 성공 기록과 admission 재승인을 확인하고 관리자 재인증으로 해제한다. kill switch 값은 PostgreSQL에 유지되며 종료된 URL은 되살아나지 않는다.
