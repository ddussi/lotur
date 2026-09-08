# GitHub 푸시부터 Gateway 배포까지

`main` 푸시 → 기존 CI 검사 → GHCR 이미지 업로드 → SSH 서버 반영 → HTTPS 검증 → 공유 허용 순서로 실행한다. PR과 다른 브랜치에서는 검사만 실행한다. GitHub Actions의 `CI` 화면에서 `Run workflow`를 눌러 `main`을 다시 실행할 수도 있다. 수동 실행도 검사를 생략하지 않는다.

처음 한 번 서버와 GitHub 설정을 연결하고 `AUTO_DEPLOY_ENABLED=true`를 지정해야 한다. 현재 저장소에는 실제 서버 주소·SSH 키가 포함되어 있지 않다. 아래 설정 없이 워크플로 파일만 올리면 자동 배포가 활성화된 것으로 보지 않는다.

## 지원하는 서버 구성

- Linux x86-64, Python 3.9 이상, Docker Engine, OpenSSH. 현재 GitHub 호스팅 runner가 만드는 이미지는 `linux/amd64`다.
- Gateway 한 개와 기존 PostgreSQL을 사용한다. 배포 계정은 해당 Docker daemon을 사용할 수 있어야 한다.
- 기존 TLS ingress가 같은 서버의 `127.0.0.1:8787` 또는 Docker 프록시망의 Gateway 컨테이너 이름으로 요청을 전달해야 한다. ingress 설정은 [Linux 배포 문서](linux-deployment.md)의 streaming·WebSocket·헤더 규칙을 따른다.
- DB·DNS·인증서·최초 관리자 계정은 기존 [최초 설치 절차](linux-deployment.md#최초-배포)로 준비한다. 이 자동화는 서버 구매, DNS 변경, 관리자 비밀번호 생성 작업을 수행하지 않는다.
- 여러 Gateway 간 무중단 전환은 제공하지 않는다. 컨테이너 교체 동안 짧은 중단이 있고 열린 공유 연결은 다시 연결해야 한다.

## 서버에 한 번 준비할 파일

배포 계정이 소유하는 `/opt/review-tunnel` 디렉터리를 만들고 권한을 `700`으로 지정한다. 아래 환경 파일과 비밀번호 파일은 `600` 또는 `400`으로 지정한다. 이 파일들은 Git이나 GitHub Secret에 올리지 않고 서버에서 관리한다.

| 파일 | 내용 |
| --- | --- |
| `deployment.json` | [설정 예시](../deploy/production/deployment.example.json)를 복사해 실제 주소·컨테이너 이름·Docker network·자원 제한을 지정 |
| `gateway.env` | 기존 Gateway 운영 환경. `.env.example`의 인증형 설정을 바탕으로 DB·HMAC 키·metrics/canary token·도메인 등 필수값 지정 |
| `admin.env` | 기존 Admin CLI 환경. 운영용 DB role·Gateway와 같은 HMAC 키·audit 상한 등 설정 |
| `migration.env` | 같은 DB에 연결하는 DDL 전용 role의 `DATABASE_URL` |
| `admin-password` | 현재 유효한 관리자 비밀번호 한 줄. `deployment.json`의 `adminUsername`과 일치 |

환경 파일은 Docker가 읽는 `KEY=value` 형식이다. `export`, 값 주변 따옴표, 셸 변수 치환을 사용하지 않는다. 관리자 계정은 임시 비밀번호 변경을 완료한 기존 `ADMIN` 계정이어야 한다. 운영 DB를 갱신하기 전에 정상 백업과 복원 절차를 준비한다.

Nginx Proxy Manager처럼 ingress도 Docker에서 실행한다면 `network`에 DB망, `proxyNetwork`에 프록시망을 지정하고 `port`를 `null`로 둔다. Gateway는 두 망에 연결되고 호스트 포트를 열지 않는다. 관리자·migration 작업은 DB망만 사용하고 공개 canary 검사는 외부 통신이 가능한 프록시망만 사용한다. ingress는 `containerName:8787`을 가리켜야 한다.

`ingressConfigPath`에는 **실제로 적용된 ingress 설정 파일**의 절대 경로를 지정한다. include 파일·외부 Load Balancer 설정을 사용하면 운영자가 전체 적용 설정을 내보낸 스냅샷 파일을 지정하고 설정 변경 때 함께 갱신한다. 이미지 digest, Gateway 환경, 배포 설정, ingress 설정을 합쳐 이번 배포의 `DEPLOYMENT_CONFIG_DIGEST`를 계산한다. 파일 내용을 CI 로그로 출력하지 않는다.

Gateway의 `GATEWAY_HOST=0.0.0.0`, 내부 `GATEWAY_PORT=8787`, `AUTO_MIGRATE=false`, 배포 ID·설정 digest는 자동화가 지정한다. `port`를 설정했을 때만 호스트의 **127.0.0.1에** 연다. `REVIEW_WORKFLOW_ENABLED`와 전역 공유 중지 스위치는 자동으로 변경하지 않는다.

이미 수동으로 실행 중인 Gateway를 처음 연결할 때는 다음으로 그 컨테이너의 전체 ID를 확인한다.

```bash
docker inspect --format '{{.Id}}' review-tunnel-gateway
```

확인한 64자리 ID를 `deployment.json`의 선택 항목 `adoptContainerId`에 지정한다. 이름만 같다는 이유로 다른 컨테이너를 교체하지 않는다. 처음 반영에 성공한 새 컨테이너에는 저장소 소유 라벨이 붙으므로 이후에는 이 항목을 제거할 수 있다. 복구 검사는 이전 컨테이너 안에서 원래 `GATEWAY_PORT`와 `CONTROL_HOST`로 실행하므로 호스트 포트를 공개하지 않았던 구성도 지원한다.

같은 디렉터리에 검토한 `scripts/deploy_gateway.py`와 `scripts/receive-deployment.py`를 설치한다. 배포 전용 SSH 키를 새로 만들고 서버의 `authorized_keys`에 다음 형식으로 **공개 키만** 추가한다. 아래 경로는 실제 설정 디렉터리로 바꾼다.

```text
restrict,command="python3 -B /opt/review-tunnel/receive-deployment.py --root /opt/review-tunnel" ssh-ed25519 <공개키> lotur-deployment
```

이 키는 고정된 `deploy` 요청만 처리하며 일반 셸·SCP 파일 업로드·포트 포워딩을 허용하지 않는다. 클라이언트는 이미지 정보와 단기 registry token만 stdin으로 보낸다. 서버 작업자 코드의 SHA-256이 저장소 코드와 다르면 배포를 거절한다. **배포 작업자 자체를 변경할 때는 검토한 두 파일을 서버에 먼저 갱신해야 한다.** 일반 앱 코드 변경에는 이 수동 단계가 필요 없다. 키가 허용하는 이미지 실행도 서버 Docker 권한을 사용하므로 배포 승인자와 저장소 쓰기 권한을 신뢰할 수 있는 팀원으로 제한한다.

## GitHub에 한 번 등록할 설정

저장소 Settings → Environments에 `production` 환경을 만든다. 이 환경의 배포 브랜치는 `main`으로 제한한다. 매 푸시마다 완전 자동으로 반영하려면 required reviewer를 지정하지 않는다. SSH 개인 키와 그 공개 키를 서버에 연결하는 작업은 선택한 배포 계정 범위에서 수행한다.

`production` 환경의 Secrets:

| 이름 | 값 |
| --- | --- |
| `DEPLOY_HOST` | 실제 서버 DNS 이름 또는 IPv4 주소 |
| `DEPLOY_USER` | SSH 배포 계정 |
| `DEPLOY_PORT` | SSH 포트, 생략 시 `22` |
| `DEPLOY_SSH_KEY` | 위 고정 명령에 연결한 배포 전용 SSH 개인 키 |
| `DEPLOY_KNOWN_HOSTS` | 서버 관리자와 fingerprint를 대조해 확인한 SSH known_hosts 항목. 기본 포트가 아니면 `[호스트]:포트` 항목 사용 |

서버 주소·계정·포트도 Secret에 저장해 Actions의 환경 설정 출력에서 마스킹한다. 이전 버전에서 같은 이름의 Variables를 사용했다면 **기존 값을 바꾸지 않고 같은 환경의 Secrets로 먼저 복사**한 뒤 새 워크플로를 적용한다. 이전 워크플로가 실행될 수 있는 동안에는 Variables도 유지한다. Secrets로 옮겨도 이미 남은 과거 로그가 소급해서 가려지지는 않으므로, 공개 전환 전에는 별도로 점검한다.

마지막으로 **저장소 Variables**에 `AUTO_DEPLOY_ENABLED=true`를 지정한다. 이 값은 이미지 게시 job에서도 사용하므로 `production` 환경에만 넣으면 켜지지 않는다. 되돌려 끄려면 이 저장소 변수를 `false`로 바꾼다.

GHCR 게시와 다운로드에는 각 job의 단기 `GITHUB_TOKEN`을 사용한다. 별도 장기 registry PAT는 필요하지 않다. 새 패키지는 워크플로 저장소에 연결되며, 기존 같은 이름의 패키지를 재사용한다면 저장소에 Actions 접근 권한이 있어야 한다. SSH 전달 시에는 읽기 권한만 있는 job token을 stdin으로 전달하고 서버의 임시 Docker 인증 디렉터리는 작업 후 제거한다.

## 매 배포에서 확인하는 순서

1. 기존 전체 CI가 성공해야 이미지를 게시한다. Gateway·Admin CLI·canary 이미지를 같은 commit SHA로 빌드하고 서버에는 변경 불가능한 `@sha256:…` 주소를 전달한다. 다운로드 뒤 이미지의 source revision도 검사한다.
2. 이미지 게시 중 `main`이 바뀌었으면 해당 실행은 배포를 건너뛴다. GitHub 배포 job과 서버 파일 잠금으로 동시 교체를 막고, 이미 배포한 실행보다 오래된 실행 번호는 서버에서도 거부한다.
3. 서버 환경과 관리자 인증을 확인한다. 공유 중지 스위치가 켜져 있으면 기존 컨테이너를 건드리지 않고 중단한다.
4. DDL 전용 계정으로 migration을 실행한다. 실패하면 실행 중인 기존 Gateway를 유지한다.
5. 기존 컨테이너를 정지·보관하고 새 Gateway를 띄운다. CPU·memory·PID·로그 크기를 제한하고 read-only filesystem과 non-root 이미지 사용을 유지한다.
6. 정확한 Gateway 컨테이너 안의 `/health/ready`와 공개 Control 주소, 실제 공개 HTTPS canary 경로의 인증·요청 streaming·SSE·WebSocket 검사를 통과해야 canary 성공을 기록한다. 프록시의 기존 Docker DNS 캐시가 갱신될 시간을 readiness 제한 안에서 기다린다.
7. 기존 Admin CLI의 `approve-admission`을 자동 실행하고 `admissionReady=true`를 확인한다. 검증 실패를 무시하거나 emergency switch를 끄지 않는다.
8. 성공한 이미지·배포 ID·설정 digest·이전 컨테이너 이름을 서버 `current-release.json`에 기록한다.

GitHub의 작업 의존성과 environment 설정은 [공식 워크플로 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), GHCR 인증 방식은 [공식 Container registry 문서](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)를 따른다.

## 실패와 복구

새 컨테이너 실행·readiness·공개 경로·공유 승인·성공 기록 저장 중 실패하면 새 컨테이너를 정지하고 이전 컨테이너를 원래 이름으로 복원한다. 이전에 실행 중이었으면 다시 시작하고 **이전 포트와 Control host**로 readiness를 확인한다. 기존 컨테이너가 없었던 첫 배포는 실패한 새 컨테이너를 정지한 상태로 끝낸다. 실패한 컨테이너는 `…-failed-<배포ID>` 이름으로 남아 서버에서 로그를 확인할 수 있다.

DB를 과거 상태로 덮어쓰거나 migration을 역실행하지 않는다. 이전 코드가 새 schema와 호환되지 않으면 복구 readiness도 실패하므로 실행 결과를 성공으로 표시하지 않는다. schema와 상태 값의 호환성을 유지하는 배포가 전제이며, 파괴적인 schema 변경은 별도 이행 절차가 필요하다.

전원 종료·강제 kill·Docker daemon 장애는 자동 복구가 끝나지 않을 수 있다. 이런 경우 서버의 보관 컨테이너와 `current-release.json`을 확인해 운영자가 복구한다. 이전·실패 컨테이너와 이미지는 자동 삭제하지 않으므로 운영 보존 주기에 따라 정리한다. `docker system prune` 같은 광범위 삭제를 배포 과정에 넣지 않는다.

## 검증

`npm run test:scripts`에서 배포 제어 흐름의 실패·복구 테스트를 함께 실행한다. 실제 SSH 서버와 TLS 경로의 첫 배포 성공은 이 로컬 테스트와 별도로 확인해야 한다. GitHub 배포 job의 성공 결과와 서버 `current-release.json`이 일치해야 실제 연결 완료로 본다.
