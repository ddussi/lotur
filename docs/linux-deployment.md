# Linux 서버 배포와 인수 절차

Review Tunnel Gateway는 화면 없는 Linux 서버에서 단일 컨테이너로 실행한다. 관리자는 자신의 PC 브라우저로 `https://<CONTROL_HOST>/admin/users`와 `/admin/operations`에 접속한다.

`main` 푸시 후 CI부터 서버 반영까지 연결하려면 [자동 배포 설정](automatic-deployment.md)을 따른다. 최초 서버·DB·DNS·관리자 준비는 아래 절차를 사용한다.

이 문서의 도메인·레지스트리·환경 파일 경로는 설치자가 바꿔야 하는 예시다. 프로젝트가 제공하는 공용 서버나 도메인은 없다. 처음 설치한다면 [시작 안내](getting-started.md), 실제 HTTPS 경로를 검증하려면 [외부 경로 검사](public-path-testing.md)를 함께 읽는다. Gateway의 살아 있는 공유 경로는 메모리에 있으므로 이 절차는 단일 Gateway 인스턴스를 기준으로 한다.

## 필수 외부 구성

- Node.js 24 실행 이미지 또는 이 저장소의 `Dockerfile`
- PostgreSQL 15 이상. 자동 검증 기준 이미지는 PostgreSQL 17.11이다.
- TLS를 종료하는 승인된 Ingress 또는 Load Balancer
- 하나의 기준 도메인 아래의 control DNS와 콘텐츠 wildcard DNS, 두 이름을 포함하는 TLS 인증서
- 환경별 secret manager와 암호화된 PostgreSQL 백업 저장소
- Prometheus scraper 또는 동등한 보호된 metrics 수집기

예시 경계:

```text
*.preview.tunnel.example.com       -> Gateway content path
canary.preview.tunnel.example.com  -> 예약된 synthetic public-path canary
control.tunnel.example.com         -> 로그인, 관리자 UI, Client API와 Carrier WSS
```

위 이름들은 하나의 기준 도메인 아래에 있다. DNS 레코드는 `control.tunnel`과 `*.preview.tunnel` 두 개가 필요하다. 기준 도메인의 선택은 운영 환경의 책임이다. 다른 서비스와 상위 도메인을 공유하면 그 서비스의 `Domain` Cookie가 콘텐츠 host 요청에 포함될 수 있으므로 기존 Cookie 정책을 확인하거나 필요한 경우 별도 기준 도메인을 사용한다. Control host를 `control.preview.tunnel.example.com`처럼 콘텐츠 wildcard 안에 넣으면 Gateway가 시작을 거부한다. 인증 Cookie는 control host 전용이며, 상태 변경 요청은 정확한 control `Origin`만 허용한다. Ingress는 외부 `Forwarded`·`X-Forwarded-*`를 신뢰하지 말고 제거한 뒤 승인된 값만 재작성해야 한다. Gateway는 기본적으로 peer socket 주소만 사용하며, `X-Forwarded-For`를 사용하려면 실제 Ingress·Load Balancer 주소 범위를 `TRUSTED_PROXY_CIDRS`에 명시해야 한다.

## 환경 변수

| 이름 | 기본값·설명 |
| --- | --- |
| `GATEWAY_HOST` | 기본 `127.0.0.1`. 컨테이너는 보통 `0.0.0.0` |
| `GATEWAY_PORT` | 내부 listener, 기본 `8787` |
| `CONTENT_DOMAIN` | scheme·wildcard 없는 콘텐츠 도메인 |
| `PUBLIC_CONTENT_ORIGIN` | 외부 검토자에게 표시할 canonical origin. 예: `https://preview.tunnel.example.com` |
| `CONTROL_HOST` | 콘텐츠 wildcard namespace 바깥의 control hostname. 예: `control.tunnel.example.com` |
| `DATABASE_URL` | PostgreSQL 연결 문자열. secret manager에서 주입 |
| `AUTH_SESSION_HMAC_KEY` | canonical base64url로 인코딩한 32~128바이트 active key |
| `AUTH_SESSION_HMAC_KEY_PREVIOUS` | 회전 overlap 동안만 쓰는 서로 다른 이전 key의 쉼표 구분 목록. 최대 3개이며 active key와 중복 금지 |
| `REVIEW_WORKFLOW_ENABLED` | 기본 `false`. DB migration 19–21과 모든 Gateway 교체 후 `true`로 새 재검토 요청 활성화. 기존 상태 읽기와 확인은 유지 |
| `AUTO_MIGRATE` | 기본 `false`. Gateway 시작 시 migration이 필요한 예외 환경에서만 명시적으로 `true` |
| `DEPLOYMENT_ID` | 배포 파이프라인이 발급한 1~128자 release ID |
| `DEPLOYMENT_CONFIG_DIGEST` | image·Ingress·운영 설정 묶음의 `sha256:<64 lowercase hex>` digest |
| `CANARY_HOST` | `CONTENT_DOMAIN` 아래의 예약된 정확한 hostname. Tunnel ID namespace로 사용하지 않음 |
| `CANARY_BEARER_TOKEN` | 32~512자 synthetic canary 전용 secret. 일반 계정·Cookie와 공유하지 않음 |
| `OPERATIONAL_STATE_POLL_INTERVAL_MS` | PostgreSQL admission·kill switch 동기화 주기, 기본 2초 |
| `DATABASE_CONNECT_TIMEOUT_MS` | PostgreSQL connection 수립 deadline, 기본 5초 |
| `DATABASE_QUERY_TIMEOUT_MS` | client query·server statement·lock deadline, 기본 3초 |
| `REVIEW_EVENT_POLL_INTERVAL_MS` | PostgreSQL Review event log polling 주기, 기본 500ms |
| `REVIEW_EVENT_HEARTBEAT_INTERVAL_MS` | Review SSE heartbeat 주기, 기본 15초 |
| `REVIEW_EVENT_RETRY_MS` | 브라우저에 알리는 Review SSE 재연결 지연, 기본 1초 |
| `MAX_REVIEW_EVENT_CONNECTIONS` | Review SSE 전역 연결 상한, 기본 128 |
| `MAX_REVIEW_EVENT_CONNECTIONS_PER_ACCOUNT` | 계정별 Review SSE 연결 상한, 기본 4이며 전역 상한 이하여야 함 |
| `MAX_REVIEW_EVENTS` | PostgreSQL에 보존할 Review event 수 상한, 기본 100000 |
| `REVIEW_EVENT_RETENTION_MS` | Review event 보존 기간, 기본 7일·최대 365일. 수량 상한과 함께 적용 |
| `METRICS_BEARER_TOKEN` | 32~512자 별도 token. 없으면 `/metrics`는 404 |
| `MAX_PENDING_TUNNELS` | credential 예약·activation 중 Tunnel과 HELLO 대기 Carrier의 전역 상한, 기본 64 |
| `MAX_ACTIVE_TUNNELS` | ACTIVE·RECONNECTING Tunnel의 전역 상한, 기본 1024 |
| `MAX_TUNNELS_PER_ACCOUNT` | 계정별 예약·활성 Tunnel 상한, 기본 8 |
| `LOGIN_INTENTS_PER_SOURCE_PER_MINUTE` | 인증 전 공유 URL 접근 source별 분당 상한, 기본 20 |
| `LOGIN_INTENTS_GLOBAL_PER_MINUTE` | 인증 전 공유 URL 접근 전역 분당 상한, 기본 1000 |
| `MAX_CONCURRENT_LOGIN_ATTEMPTS` | Argon2 자격 증명 검증의 전역 동시 실행 상한, 기본 32 |
| `MAX_CONCURRENT_LOGIN_ATTEMPTS_PER_REMOTE` | 원격 주소별 자격 증명 검증 동시 실행 상한, 기본 4 |
| `LOGIN_ATTEMPTS_PER_MINUTE` | 자격 증명 검증 전역 분당 상한, 기본 1000 |
| `LOGIN_ATTEMPTS_PER_REMOTE_PER_MINUTE` | 원격 주소별 자격 증명 검증 분당 상한, 기본 30 |
| `MAX_CONCURRENT_WEB_AUTHORIZATIONS` | Cookie·교환 코드·관리자 재인증 등 웹 인증 작업의 전역 동시 실행 상한, 기본 32 |
| `MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE` | 신뢰 경계에서 결정한 원격 주소별 웹 인증 작업 동시 실행 상한, 기본 4이며 전역 상한 이하여야 함 |
| `TRUSTED_PROXY_CIDRS` | `X-Forwarded-For`를 제공할 수 있는 peer의 명시적 CIDR 목록, 최대 32개. 기본은 미설정이며 헤더를 신뢰하지 않음 |
| `MAX_FORWARDED_FOR_ENTRIES` | 신뢰한 `X-Forwarded-For` chain의 최대 항목 수, 기본 16·최대 64. `TRUSTED_PROXY_CIDRS`와 함께만 설정 |
| `MAX_OUTSTANDING_CARRIER_CREDENTIALS` | 미소비 Carrier credential·reservation 전역 상한, 기본 128 |
| `MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT` | 계정별 미소비 Carrier credential·reservation 상한, 기본 8 |
| `CARRIER_CREDENTIALS_PER_MINUTE` | Carrier credential 발급 전역 분당 상한, 기본 1000 |
| `CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE` | 계정별 Carrier credential 발급 분당 상한, 기본 60 |
| `MAX_AUTH_SESSIONS` | 미만료 로그인 Session 전역 상한, 기본 100000 |
| `MAX_AUTH_SESSIONS_PER_ACCOUNT` | 계정별 미만료 로그인 Session 상한, 기본 64 |
| `MAX_SESSION_EXCHANGES` | 미소비 content Session exchange 전역 상한, 기본 10000 |
| `MAX_SESSION_EXCHANGES_PER_ACCOUNT` | 계정별 미소비 content Session exchange 상한, 기본 256 |
| `MAX_LOGIN_THROTTLES` | 최근 15분 login throttle key의 hard cap, 기본 100000·최소 2·최대 10000000 |
| `MAX_AUDIT_EVENTS` | 영구 관리자·운영 audit event의 hard cap, 기본 1000000·최대 100000000 |
| `AUDIT_OPERATIONAL_RESERVE` | 계정 변경 flood가 kill switch 등 운영 감사를 막지 않도록 남기는 audit 슬롯, 기본 1000·최대 10000000이며 전체 상한보다 작아야 함 |
| `MAX_PENDING_CARRIER_FRAMES` | 처리 대기 중인 Carrier inbound frame 수 상한, 기본 128 |
| `MAX_PENDING_CARRIER_BYTES` | 처리 대기 중인 Carrier inbound byte 상한, 기본 262204 |
| `MAX_CANARY_WEBSOCKETS` | synthetic canary WebSocket 동시 연결 상한, 기본 4 |
| `CANARY_WEBSOCKET_IDLE_TIMEOUT_MS` | synthetic canary WebSocket 유휴 종료 시간, 기본 30초 |
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

`MAX_AUDIT_EVENTS`, `AUDIT_OPERATIONAL_RESERVE`, `MAX_LOGIN_THROTTLES`는 Gateway와 Admin CLI에 동일하게 주입한다. 계정·비밀번호·권한·회수와 운영 제어는 PostgreSQL audit에 저장되며, 로그인 성공·실패는 원문 아이디·원격 주소·비밀번호 없이 HMAC 참조를 포함한 `authentication_event` JSON 로그로 보낸다. 관리자 audit가 `MAX_AUDIT_EVENTS - AUDIT_OPERATIONAL_RESERVE`에 도달하면 계정 변경은 transaction 전체가 실패하고, 운영 reserve가 남아 있는 동안 kill switch 같은 운영 제어는 계속 감사와 함께 기록된다. 전체 audit 상한에 도달한 뒤에는 상태 변경도 fail-closed하므로, 운영자는 그 전에 감사 보존 정책에 따라 백업·외부 보관과 새 배포 DB로의 계획된 전환을 수행한다.

Session 최대 수명 8시간, Stream이 없을 때 유휴 30분, resume 유예 2분은 v1 고정 정책이다. 운영 인증 모드에서 HTTP Cookie를 허용하는 `ALLOW_INSECURE_HTTP_AUTH`는 loopback 통합 테스트 외에는 사용하지 않는다.

원격 주소는 socket peer부터 `X-Forwarded-For`를 오른쪽에서 왼쪽으로 검증해 최초의 미신뢰 주소로 결정한다. 미신뢰 peer가 보낸 헤더, 중복 헤더, 잘못된 IP, 2 KiB 초과 값 또는 항목 상한을 넘긴 chain은 사용하지 않고 socket peer로 fail-closed 그룹화한다. 따라서 실제 proxy hop 전체를 빠짐없이 CIDR 목록에 넣고, Ingress에서 외부 입력 헤더를 제거한 뒤 단일 헤더로 재작성해야 한다.

인증 모드에서는 `GATEWAY_ADMISSION_READY`와 `KILL_SWITCH_ENABLED` 환경변수를 사용하면 시작을 거부한다. 두 값은 재시작 후에도 유지되고 여러 실행 주체가 같은 결과를 보도록 PostgreSQL에서만 변경한다. 운영 상태 조회가 실패하면 기존 kill switch 값은 유지하되 신규 Session admission은 즉시 닫힌다. 같은 DB의 계정 권한 재검증까지 실패하면 cached allow로 버티지 않고 관련 Carrier·Stream을 fail-closed 종료한다.

HMAC key와 metrics token 생성 예:

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
```

## 배포 전 자동 검증

Node 24에서 다음을 실행한다.

```bash
npm ci
npx playwright install --with-deps chrome
TEST_DATABASE_URL=<isolated-test-database-url> npm run check:mvp
npm audit --omit=dev
```

`check:mvp`는 typecheck·build·architecture·script·단위·실제 PostgreSQL·프레임워크 검증을 한 번에 실행한다. `test:frameworks`는 Playwright의 `channel: "chrome"`에 맞춰 설치한 Google Chrome에서 Vite 8.2.2와 Next.js 16.3.3·React 19.2.8 fixture를 실제 Tunnel에 연결한다. 저장소의 CI workflow도 같은 완료 게이트를 실행하고 PostgreSQL 테스트를 skip하지 않으며, 여섯 production target을 실제 build한 뒤 각 entrypoint가 예상한 설정 오류로 fail-closed하는지 smoke 검증한다.

역할별 image는 같은 소스 revision에서 명시적으로 빌드한다. target을 생략한 기본 image도 Gateway지만 배포 파이프라인에서는 target 이름을 고정한다.

```bash
docker build --target gateway -t registry.example/review-tunnel-gateway:<release> .
docker build --target admin-cli -t registry.example/review-tunnel-admin:<release> .
docker build --target client -t registry.example/review-tunnel-client:<release> .
docker build --target canary-check -t registry.example/review-tunnel-canary:<release> .
docker build --target db-backup -t registry.example/review-tunnel-db-backup:<release> .
docker build --target db-restore -t registry.example/review-tunnel-db-restore:<release> .
```

### 공식 image digest 확인과 Docker Desktop credential 문제

`Dockerfile`은 2026-09-09에 Docker Hub 공식 레지스트리 응답으로 재확인한 `node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`와 `postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`에 고정한다. tag의 multi-platform OCI index digest를 pin하므로 amd64와 arm64가 같은 Dockerfile에서 각 플랫폼 image를 선택한다.

macOS Docker Desktop에서 `docker pull`이나 `docker buildx imagetools inspect`가 image 조회 전에 멈추고 `error getting credentials`로 끝나며 `~/.docker/config.json`이 `credsStore: desktop`을 사용하는 경우, registry나 digest가 아니라 credential helper 상태를 먼저 의심한다. 사용자 설정을 수정하지 않고 공개 공식 image만 진단하려면 빈 임시 Docker config로 built-in manifest 명령을 실행한다.

```bash
mkdir -p /tmp/review-tunnel-docker-anonymous
DOCKER_CONFIG=/tmp/review-tunnel-docker-anonymous \
  docker manifest inspect node:24-bookworm-slim
DOCKER_CONFIG=/tmp/review-tunnel-docker-anonymous \
  docker manifest inspect postgres:17.11-bookworm
```

같은 `DOCKER_CONFIG`로 실제 target build까지 통과하면 registry 접근과 digest는 정상이고 기존 credential helper가 실패 지점이다. 이 우회는 공개 image 진단에만 사용한다. private registry 자격 증명이나 운영자의 Docker 설정을 지우지 말고, Docker Desktop 재시작·credential store 복구가 필요한 경우에는 환경 소유자의 명시적 승인과 절차를 따른다.

2026-09-01 재확인 때처럼 `docker manifest inspect`와 `docker buildx imagetools inspect`가 credential 오류 없이도 출력 없이 끝나면 Docker Hub 공식 Registry v2의 Bearer 인증과 `HEAD` 응답으로 index digest를 교차 확인한다. 아래 token은 공개 `pull` scope의 단기 token이며 저장하거나 로그로 출력하지 않는다.

```bash
node_registry_token=$(curl -fsSL \
  'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull' \
  | jq -r .token)
curl -fsSI \
  -H "Authorization: Bearer ${node_registry_token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  'https://registry-1.docker.io/v2/library/node/manifests/24-bookworm-slim' \
  | grep -i '^docker-content-digest:'

postgres_registry_token=$(curl -fsSL \
  'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull' \
  | jq -r .token)
curl -fsSI \
  -H "Authorization: Bearer ${postgres_registry_token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  'https://registry-1.docker.io/v2/library/postgres/manifests/17.11-bookworm' \
  | grep -i '^docker-content-digest:'
```

Gateway·Admin CLI·Client·canary target은 non-root `node` 사용자로, PostgreSQL backup/restore target은 client image의 non-root `postgres` 사용자로 실행된다. Gateway는 read-only root filesystem, `no-new-privileges`, 명시적인 CPU·memory 제한과 종료 유예를 배포 정의에서 추가한다. Admin CLI와 canary는 상주 service가 아니라 `--rm` one-off job으로 실행하고 Gateway image의 command를 바꿔 재사용하지 않는다.

역할별 실행 형태는 다음과 같다. `<runtime-env>`는 권한 `0600`의 임시 예시일 뿐이며 운영에서는 orchestrator secret injection을 우선한다.

```bash
# 상주 Gateway
docker run --read-only --init --restart unless-stopped \
  --security-opt no-new-privileges --env-file <runtime-env> \
  -p 127.0.0.1:8787:8787 registry.example/review-tunnel-gateway:<release>

# migration 전용 DDL role one-off. AUTH_SESSION_HMAC_KEY는 필요하지 않다.
docker run --rm -it --env-file <runtime-env> \
  registry.example/review-tunnel-admin:<release> migrate

# public-path canary one-off
docker run --rm \
  -e CANARY_CONTENT_URL=https://canary.preview.tunnel.example.com \
  -e CANARY_BEARER_TOKEN \
  registry.example/review-tunnel-canary:<release>
```

`migrate`는 인증·운영·리뷰 테이블을 순서대로 만든다. 기존 공유 전용 DB를 업그레이드할 때도 새 Gateway를 실행하기 전에 DDL role로 이 명령을 수행한다. 반복 실행할 수 있으며 기존 데이터를 지우지 않는다.

계정·admission·kill switch 명령은 migration을 자동 실행하지 않는다. 이 job에는 schema DDL 권한을 주지 않고 필요한 `AUTH_SESSION_HMAC_KEY`와 DML 권한만 별도로 주입한다.

Linux 개발자가 Client image로 같은 호스트의 로컬 개발 서버를 공유하려면 `--network host`를 사용한다. 배포 환경이 host network를 금지하면 로컬 origin에만 접근 가능한 별도 명시적 network를 만든다.

```bash
docker run --rm -it --network host \
  -e GATEWAY_URL=wss://control.tunnel.example.com/_review-tunnel/carrier \
  -e CONTROL_URL=https://control.tunnel.example.com \
  registry.example/review-tunnel-client:<release> \
  http://127.0.0.1:3000 --username developer1
```

인증 모드 Client는 비밀번호를 보내는 Control origin과 1회용 Carrier credential을 보내는 Gateway URL의 host·port가 정확히 같고 `https`↔`wss`로 대응할 때만 시작한다. 평문 `http`↔`ws` 조합은 명시적인 loopback literal 또는 `localhost`에서만 허용한다. 서로 다른 endpoint로 secret이 분리 전송되도록 구성할 수 없다.

PostgreSQL 실연동은 격리된 테스트 DB에서 실행한다.

```bash
docker compose -f compose.test.yml up -d --wait
TEST_DATABASE_URL=postgres://review_tunnel_test:local-test-only@127.0.0.1:54329/review_tunnel_test npm run test:postgres
docker compose -f compose.test.yml down
```

이 Compose의 데이터 경로는 tmpfs다. 운영 DB URL을 `TEST_DATABASE_URL`에 넣지 않는다.

## 최초 배포

1. PostgreSQL과 secret을 만들고 DDL 전용 DB role로 Admin CLI image의 `migrate`를 별도 one-off 작업으로 실행한다. Gateway와 일반 Admin CLI DB role에는 DDL 권한을 주지 않으며 `AUTO_MIGRATE`는 기본 `false`를 유지한다.
2. `DATABASE_URL`과 `AUTH_SESSION_HMAC_KEY`가 있는 계정 관리 전용 환경 파일을 사용해 최초 관리자와 새 비밀번호를 만든다.

```bash
docker run --rm -it --env-file <account-admin-env> \
  registry.example/review-tunnel-admin:<release> \
  bootstrap --username admin --display-name "운영 관리자"
docker run --rm -it --env-file <account-admin-env> \
  registry.example/review-tunnel-admin:<release> \
  change-password --username admin
```

3. 후보 Gateway를 사용자 트래픽이 없는 target group에 올린다. `/health/live`와 `/health/ready`가 성공하는지 확인한다.
4. Ingress에서 control host HTTP·WSS와 콘텐츠 wildcard의 request streaming·SSE·WebSocket Upgrade를 같은 후보로 보낸다. 동적 Tunnel별 router나 인증서를 만들지 않는다.
5. `CANARY_HOST`의 예약 경로를 실제 DNS·TLS·Load Balancer·Ingress를 통해 검사한다. 이 fixture는 Gateway 자체의 synthetic marker만 사용하며 Tunnel, 일반 사용자 Cookie, Session admission과 kill switch에 의존하지 않는다.

```bash
docker run --rm \
  -e CANARY_CONTENT_URL=https://canary.preview.tunnel.example.com \
  -e CANARY_BEARER_TOKEN \
  registry.example/review-tunnel-canary:<release>
```

이 검사는 미인증 요청 차단, 인증된 marker, 전체 upload 종료 전 request 첫 응답, SSE의 첫 read가 두 번째 marker까지 합쳐 버리지 않는 점과 WebSocket binary echo를 확인한다. bearer는 secret manager가 안전한 one-off job에만 주입하며 shell history, CI log, ticket이나 일반 Gateway access log에 남기지 않는다.

6. 검사 결과를 같은 `DEPLOYMENT_ID`·`DEPLOYMENT_CONFIG_DIGEST`에 기록한다. 실패 경로도 반드시 `failed`로 기록하고 후보를 승격하지 않는다.

```bash
docker run --rm -it --env-file <account-admin-env> \
  registry.example/review-tunnel-admin:<release> \
  record-canary --as admin --result passed \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
```

7. canary 성공 기록만으로 admission은 열리지 않는다. 관리자 또는 승인된 배포 파이프라인이 별도 명령으로 같은 identity를 명시 승인한다. 이 두 명령은 모두 관리자 비밀번호 재확인이 필요하며 자동화에서는 `--password-stdin`과 secret input을 사용한다.

```bash
docker run --rm -it --env-file <account-admin-env> \
  registry.example/review-tunnel-admin:<release> \
  approve-admission --as admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
docker run --rm -it --env-file <account-admin-env> \
  registry.example/review-tunnel-admin:<release> \
  admission-status --as admin \
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

1. 새 key를 `AUTH_SESSION_HMAC_KEY`에 넣고 기존 active key를 `AUTH_SESSION_HMAC_KEY_PREVIOUS`에 넣어 maintenance rollout한다. previous key는 active key와 달라야 하고 최대 3개다. Gateway 재시작은 기존 Tunnel URL을 종료한다.
2. overlap 중 새 로그인·교환·Carrier credential은 새 key로 발급되고 기존 로그인 세션은 이전 key 후보로 검증된다.
3. 로그인 세션 최대 12시간과 시계 오차가 지난 뒤 previous key를 제거한다. 문제가 있으면 active·previous 순서를 되돌려 다시 rollout한다.
4. key 원문이나 key ID를 애플리케이션 로그에 쓰지 않는다.

## PostgreSQL 백업과 복구 훈련

백업은 현재 사용자가 소유한 `0700` 디렉터리만 허용하고, 충돌 방지 난수 이름의 custom format 임시 파일을 `0600`·exclusive create로 먼저 선점한 뒤 열린 file descriptor에 기록한다. inode·link 수·크기를 재검증하고 file `fsync` 후 같은 디렉터리의 고유 최종 이름으로 원자 rename한 다음 directory까지 `fsync`한다. 정상 오류와 종료 signal에서는 partial 파일을 정리한다.

```bash
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npm run backup:postgres -- --output-dir /var/lib/review-tunnel/backups
```

서버에 PostgreSQL client를 별도 설치하지 않을 때는 server와 같은 17.11 client를 고정한 one-off image를 사용한다. mount 디렉터리는 image의 non-root `postgres` 사용자가 쓸 수 있어야 한다. 배포 시 `docker run --rm --entrypoint id registry.example/review-tunnel-db-backup:<release>`로 그 release의 실제 UID·GID를 확인해 host volume 소유권을 준비하고, Gateway·Client의 `node` UID라고 가정하지 않는다.

```bash
docker run --rm \
  -v /var/lib/review-tunnel/backups:/backup \
  -e DATABASE_URL \
  registry.example/review-tunnel-db-backup:<release> --output-dir /backup
```

백업을 별도 암호화 저장소로 복제하고 checksum·보존 정책을 적용한다. 복구 도구는 symlink를 따르지 않고 입력을 private 임시 디렉터리의 불변 snapshot으로 복사한 뒤, 같은 snapshot의 archive 목록을 먼저 검증하고 `--clean --single-transaction`으로 복구한다. 중간 오류는 rollback되지만 archive에 없는 기존 객체까지 정리하지는 않는다. Gateway를 중지한 비어 있는 격리 DB에서 먼저 수행하고 검증된 DB 교체 절차로 승격한다. 기본 PostgreSQL DB에는 복구할 수 없고 정확한 host·port·DB 확인 문자열이 필요하다. 복구 child process는 URL로부터 만든 접속 설정만 사용하며 상속된 `PG*` override나 그 밖의 secret 환경을 전달하지 않는다. 두 도구는 문서화되지 않은·중복된 CLI 인자를 거부하고 `SIGINT`·`SIGTERM`을 현재 PostgreSQL child에 전달한다. 대용량 snapshot 복사도 chunk 사이에서 signal을 관찰해 partial을 정리하며, 목록 검증과 파괴적 실행 사이에 signal을 받으면 두 번째 child를 시작하지 않는다.

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
