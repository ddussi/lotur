# 처음 사용하는 사람을 위한 시작 안내

Review Tunnel은 하나의 도메인 아래에 인증형 Gateway를 구성해 사용한다.

## 인증형 Gateway 운영

이 방식은 개발자 컴퓨터가 아니라 별도 Linux 서버에 Gateway를 한 번 설치해 두는 방식이다. 그 뒤 각 개발자는 Client 명령만 실행한다.

### 준비할 것

1. **DNS를 설정할 수 있는 도메인 하나**
2. Gateway를 계속 실행할 Linux 서버 또는 컨테이너 환경
3. PostgreSQL 15 이상
4. DNS와 TLS 인증서를 설정할 권한
5. DB 비밀번호와 HMAC key를 보관할 secret manager
6. 최초 설정을 담당할 관리자 한 명

하나의 기준 도메인 아래에 다음 두 DNS 이름을 만든다.

```text
control.tunnel.example.com             로그인·관리·Client 연결
*.preview.tunnel.example.com           공유 화면 전체
```

`control.tunnel` DNS 레코드와 `*.preview.tunnel` wildcard DNS 레코드를 같은 Gateway 앞단으로 보낸다. TLS 인증서에는 `control.tunnel.example.com`과 `*.preview.tunnel.example.com`을 넣는다. Wildcard 인증서는 보통 DNS-01 검증이 필요하므로 사용하는 DNS 업체의 자동화 방법을 따른다.

Control host는 반드시 콘텐츠 wildcard 바깥이어야 한다. 예를 들어 `control.preview.tunnel.example.com`은 허용되지 않는다.

어떤 기준 도메인을 사용할지는 운영자가 정한다. 다른 서비스와 상위 도메인을 공유하면 그 서비스가 설정한 `Domain` Cookie가 공유 화면 요청에도 포함될 수 있으므로 기존 Cookie 정책을 확인한다.

### Gateway의 핵심 설정

```dotenv
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=8787
CONTENT_DOMAIN=preview.tunnel.example.com
PUBLIC_CONTENT_ORIGIN=https://preview.tunnel.example.com
CONTROL_HOST=control.tunnel.example.com
DATABASE_URL=postgres://...
AUTH_SESSION_HMAC_KEY=<32바이트 이상의 base64url key>
DEPLOYMENT_ID=<배포를 구분하는 release ID>
DEPLOYMENT_CONFIG_DIGEST=sha256:<배포 설정을 식별하는 64자리 lowercase hex>
CANARY_HOST=canary.preview.tunnel.example.com
CANARY_BEARER_TOKEN=<32자 이상의 별도 secret>
```

위 값은 예시일 뿐이며 애플리케이션이 `.env` 파일을 자동으로 읽지는 않는다. 실행 환경이나 secret manager가 Gateway와 Admin CLI에 값을 주입해야 한다. Ingress나 reverse proxy는 control host와 wildcard host의 HTTP streaming, SSE, WebSocket을 모두 Gateway `8787` 포트로 전달해야 한다. 상세한 운영 한도와 배포 검증은 [Linux 배포 문서](linux-deployment.md)에 있다.

### 최초 계정 준비

다음 명령은 `DATABASE_URL`이 주입된 환경에서 실행한다. `bootstrap`과 `change-password`에는 같은 `AUTH_SESSION_HMAC_KEY`도 필요하다.

```bash
npm run admin -- migrate
npm run admin -- bootstrap --username admin --display-name "운영 관리자"
npm run admin -- change-password --username admin
```

그다음 관리자가 `/admin/users`에서 개발자와 검토자 계정을 만든다.

- 개발자 계정: `DEVELOPER`
- 공유 주소를 여는 사람: `REVIEWER`

### Gateway 실행과 공개 경로 승인

1. 위 환경변수를 주입한 상태에서 Gateway를 실행한다.

```bash
npm run dev:gateway
```

2. DNS·TLS·Ingress를 통과하는 canary host를 별도 터미널에서 검사한다.

```bash
CANARY_CONTENT_URL=https://canary.preview.tunnel.example.com \
CANARY_BEARER_TOKEN="$CANARY_BEARER_TOKEN" \
npm run verify:public-path
```

3. 같은 배포 ID와 설정 digest에 검사 성공을 기록하고 별도로 admission을 승인한다. Admin CLI 환경에는 `DATABASE_URL`과 `AUTH_SESSION_HMAC_KEY`가 필요하다.

```bash
npm run admin -- record-canary --as admin --result passed \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
npm run admin -- approve-admission --as admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
npm run admin -- admission-status --as admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
```

`admissionReady:true`를 확인한 뒤에만 개발자 공유가 활성화된다.

### 개발자가 공유할 때

```bash
GATEWAY_URL=wss://control.tunnel.example.com/_review-tunnel/carrier \
CONTROL_URL=https://control.tunnel.example.com \
npm run share -- http://127.0.0.1:3000 --username developer1
```

Client가 출력한 `https://임시이름.preview.tunnel.example.com` 주소를 검토자에게 보낸다. 검토자는 자신의 `REVIEWER` 계정으로 로그인한다.

## 어떤 준비가 누구 책임인가

| 역할 | 책임 |
| --- | --- |
| 개발자 | 로컬 앱을 실행하고 계정으로 Client 실행 |
| 검토자 | 공유 URL을 열고 로그인 |
| 운영자 | 서버·DB·DNS·TLS·계정·백업 관리 |
| Review Tunnel | 공유 URL, 인증, 중계, 운영 제어 제공 |

Review Tunnel은 특정 DNS 업체나 클라우드 계정을 대신 만들지 않는다. 운영형의 서버·DB·DNS·TLS는 배포 환경에 맞게 준비한다.
