# 처음 사용하는 사람을 위한 시작 안내

Review Tunnel은 하나의 도메인 아래에 인증형 Gateway를 구성해 사용한다. 제품은 로컬 웹앱을 공유하고 화면의 페이지·영역에 댓글을 남기는 리뷰 흐름을 지향한다.

> [!NOTE]
> 이 문서는 안전한 공유 기반과 현재 소스 트리의 화면 맥락 리뷰 MVP 사용 방법을 설명한다. 페이지·영역 댓글, 답글, 버전 기반 수정·삭제, 해결·다시 열기, Review SSE, 참여자 멘션·내부 알림과 Vite·Next.js integration을 제공한다.

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

### 페이지·영역 댓글 review 모드

현재 review mode는 앱 HTML을 자동 변환하지 않는다. 검토할 앱의 review 전용 entry에 다음 bootstrap을 명시적으로 넣는다. 이 예약 경로는 Gateway가 직접 처리하며 로컬 앱으로 전달하지 않는다.

```html
<script type="module" src="/_review-tunnel/review/bootstrap.js"></script>
```

개발자는 같은 소유자 안에서 안정적으로 유지할 project slug와, 검토 기준을 바꾸지 않는 revision key를 함께 지정한다.

```bash
GATEWAY_URL=wss://control.tunnel.example.com/_review-tunnel/carrier \
CONTROL_URL=https://control.tunnel.example.com \
npm run share -- http://127.0.0.1:3000 --username developer1 \
  --review-project storefront --review-revision 4a1b2c3d
```

두 옵션은 반드시 함께 사용해야 하며 인증된 `DEVELOPER` 계정이 필요하다. Client는 중계 Tunnel이 활성화된 뒤 review binding을 만들고, 둘 다 성공해야 공유 URL을 출력한다. binding이 실패하면 새 Tunnel을 닫고 실패 원인을 표시한다.

로그인한 `DEVELOPER`와 `REVIEWER`는 sidebar에서 현재 `location.pathname`의 페이지 댓글과 답글을 조회·작성할 수 있다. `영역 선택`을 켜고 지점을 클릭하면 핀을, 드래그하면 사각 영역을 남긴다. 핀과 목록은 서로 강조되며 `Esc`로 선택을 취소한다.

작성자는 열린 스레드의 자기 댓글·답글을 수정할 수 있다. 작성자 또는 `DEVELOPER`는 확인 뒤 콘텐츠를 삭제할 수 있으며, 삭제는 관계를 보존하는 tombstone으로 남고 본문은 제거된다. 수정·삭제는 화면이 가진 `expectedVersion`을 비교하므로 다른 화면에서 먼저 변경되면 `409` 충돌로 표시된다. `DEVELOPER`는 스레드를 해결하거나 다시 열 수 있고, 해결된 스레드는 다시 열기 전까지 답글과 콘텐츠 수정을 받지 않는다.

본문의 `@username`은 같은 프로젝트·revision에 참여한 프로젝트 소유자 또는 기존 작성자만 멘션한다. 자기 자신, 중복 및 알 수 없는 사용자는 알림 대상에서 제외된다. 알림은 Review Tunnel 내부에만 저장되고 sidebar에서 읽음·안 읽음을 바꿀 수 있으며 이메일·Slack·push는 보내지 않는다. 댓글·답글·상태·수정·삭제·알림 변경은 Review 전용 SSE로 현재 project·revision·path에 실시간 반영된다.

`pushState`, `replaceState`, 뒤로/앞으로 가기로 path가 바뀌면 목록을 다시 읽는다. 같은 project와 revision으로 새 Tunnel을 열면 PostgreSQL에 저장된 댓글·답글·해결 상태를 다시 볼 수 있다.

bootstrap을 넣지 않으면 review binding만 생성되고 sidebar는 나타나지 않는다. 일반 공유 명령과 중계 동작은 기존과 같다.

### Vite와 Next.js integration

Vite에서는 개발 서버 전용 plugin이 공식 HTML transform으로 bootstrap을 주입한다.

```ts
import { defineConfig } from "vite";
import { reviewTunnel } from "@review-tunnel/vite";

export default defineConfig({
  plugins: [reviewTunnel()],
});
```

`reviewTunnel()`은 bootstrap 주입만 담당한다. 인증, review binding과 Tunnel 프로세스 수명주기는 위의 `npm run share ... --review-project ... --review-revision ...` 흐름이 담당한다. 패키지가 별도 Client를 숨겨서 실행하지 않으므로 개발 서버 재시작과 Tunnel 종료 순서가 명시적이다.

앱이 nonce 기반 CSP를 사용한다면 같은 nonce를 `reviewTunnel({ nonce })`에 넘긴다. 플러그인은 그 값을 bootstrap `<script>`에 붙이고, 오버레이는 그 nonce를 Shadow DOM의 `<style>`에도 이어서 사용한다. 위치가 바뀌는 핀과 선택 영역은 inline style 대신 SVG 속성을 사용하므로 `style-src-attr 'unsafe-inline'`을 추가할 필요가 없다.

Next.js App Router에서는 통제하는 preview origin만 개발 origin에 병합하고 root layout에 bootstrap을 명시한다.

```js
// next.config.mjs
import { withReviewTunnel } from "@review-tunnel/next";

export default withReviewTunnel({}, {
  allowedDevOrigins: ["*.preview.tunnel.example.com"],
});
```

```jsx
// app/layout.jsx
import Script from "next/script";
import { reviewTunnelScriptProps } from "@review-tunnel/next";

export default function RootLayout({ children }) {
  const scriptProps = reviewTunnelScriptProps();
  return <html><body>
    {children}
    {scriptProps === undefined ? null : <Script {...scriptProps} />}
  </body></html>;
}
```

`withReviewTunnel()`과 `reviewTunnelScriptProps()`는 기본적으로 `NODE_ENV=production`에서 비활성화된다. 따라서 실제 Next production build의 HTML에는 bootstrap 경로가 들어가지 않는다. Vite plugin도 `apply: "serve"`라 build에는 적용되지 않는다. 두 공개 패키지는 비공개 workspace 의존성 없이 컴파일된 JavaScript와 선언 파일만 배포하며, 외부 임시 프로젝트의 tarball 설치·import 검사를 완료 게이트에 포함한다.

위 `nonce`는 앱이 해당 응답의 CSP 헤더에 넣은 것과 같은 요청별 값이어야 한다. CSP를 끄거나 `unsafe-inline`로 약화하는 대신 이 값을 명시적으로 전달한다.

## 어떤 준비가 누구 책임인가

| 역할 | 책임 |
| --- | --- |
| 개발자 | 로컬 앱을 실행하고 계정으로 Client 실행 |
| 검토자 | 공유 URL을 열고 로그인 |
| 운영자 | 서버·DB·DNS·TLS·계정·백업 관리 |
| Review Tunnel | 공유 URL, 인증, 중계, 운영 제어 제공 |

Review Tunnel은 특정 DNS 업체나 클라우드 계정을 대신 만들지 않는다. 운영형의 서버·DB·DNS·TLS는 배포 환경에 맞게 준비한다.
