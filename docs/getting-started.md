# 처음 사용하는 사람을 위한 시작 안내

Review Tunnel은 개발 중인 웹사이트를 다른 사람이 브라우저에서 직접 사용해 보도록 공유하는 도구다. 운영자가 자신의 서버와 도메인에 Gateway를 설치하고, 개발자는 Client로 로컬 웹앱을 연결한다. [English guide](getting-started.en.md)도 제공한다.

이 문서의 `tunnel.example.com`은 설명용 주소다. 설치자가 선택한 도메인으로 바꿔 사용하며 유지보수자의 서버나 계정을 이용하지 않는다. 소스 저장소를 내려받은 뒤 모든 `npm` 명령은 저장소 루트에서 실행한다. Node.js 24 이상에서 먼저 `npm ci`로 의존성을 설치한다.

> [!NOTE]
> 이 문서는 안전한 공유 기반과 현재 소스 트리의 화면 맥락 리뷰 MVP 사용 방법을 설명한다. 페이지·영역 댓글, 답글, 버전 기반 수정·삭제, 해결·다시 열기, Review SSE, 참여자 멘션·내부 알림과 Vite·Next.js integration을 제공한다.

## 이미 서버가 있는 경우: 화면을 공유하고 검토받기

예를 들어 개발 중인 쇼핑몰을 동료에게 휴대폰으로 확인해 달라고 부탁하는 상황이다.

1. 운영자에게 control 주소와 `DEVELOPER` 계정을 받는다. 임시 비밀번호를 받았다면 먼저 control 주소의 `/login`에서 로그인하고 비밀번호를 변경한다.
2. **쇼핑몰 프로젝트 폴더**에서 평소 개발 명령을 실행한다. 아래 예시는 웹앱이 `http://127.0.0.1:3000`에서 열리는 경우다.
3. 다른 터미널의 **Review Tunnel 저장소 폴더**에서 공유 명령을 실행한다.

```sh
npm run share -- http://127.0.0.1:3000 \
  --gateway wss://control.tunnel.example.com/_review-tunnel/carrier \
  --username developer1
```

4. 비밀번호를 입력한 뒤 출력된 공유 주소를 동료에게 보낸다. 동료는 `REVIEWER` 계정으로 로그인한다. 검토자에게는 프로그램 설치·SSH·별도 도메인이 필요 없다.
5. 동료가 메뉴·버튼·입력창을 사용하고 피드백을 전달한다. 개발자가 코드를 수정하면 지원되는 개발 서버의 자동 갱신으로 변경 내용을 볼 수 있다. 아래 리뷰 모드를 설정하면 화면 안에서 댓글·영역 핀·답글을 주고받는다.
6. 공유를 끝낼 때 공유 터미널에서 `Ctrl+C`를 누른다. 공유 중에는 개발자 컴퓨터, 웹앱, Client가 모두 실행 중이어야 한다.

`3000`은 실제 포트로 바꾼다. Client가 공유하는 것은 해당 HTTP origin 전체다. 웹앱이 브라우저에서 다른 `localhost` 포트로 API를 직접 호출하면 검토자의 컴퓨터를 가리키므로, 개발 서버에서 API를 같은 origin 아래로 프록시하는 등의 앱 설정이 필요하다.

`DEVELOPER`와 `REVIEWER`의 공유 화면 접근 권한은 서버 전체에 적용된다. 프로젝트별 접근 목록은 아직 없어 다른 공유 주소를 아는 개발자·검토자도 접근할 수 있다. `ADMIN`만으로는 공유 화면을 볼 수 없다.

## 주소와 연결 수명

| 항목 | 동작 |
| --- | --- |
| 기본 도메인 | 운영자가 지정. 모든 설치가 같은 도메인을 쓰지 않음 |
| 공유 주소 | 공유마다 `https://<발급된-ID>.preview.tunnel.example.com/` 생성 |
| 일시적인 연결 끊김 | 2분 유예 안에 인증된 재연결이 성공하면 같은 주소 유지 |
| 최대 수명 | 8시간 |
| 미사용 종료 | 진행 중인 Stream이 없는 상태에서 30분 |
| Client 종료·Gateway 재시작 | 해당 공유 종료. 다시 공유하면 새 주소 발급 |

아래는 **서버를 처음 설치하는 운영자**의 작업이다. 기존 서버를 사용하는 개발자·검토자는 이 설치 과정을 수행하지 않는다.

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

검토자가 기본 포트가 아닌 주소로 로그인한다면 `CONTROL_HOST=control.tunnel.example.com:8443`처럼 포트를 포함한다. 로그인 복귀 주소와 영구 리뷰 링크에도 그 포트를 유지한다. `CONTENT_DOMAIN`과 `CANARY_HOST`는 포트 없는 DNS 이름으로 두고, 콘텐츠 포트는 `PUBLIC_CONTENT_ORIGIN`에 지정한다. Control hostname은 포트와 무관하게 콘텐츠 wildcard 바깥이어야 한다.

### 최초 계정 준비

다음 명령은 `DATABASE_URL`이 주입된 환경에서 실행한다. `bootstrap`과 `change-password`에는 같은 `AUTH_SESSION_HMAC_KEY`도 필요하다.

```bash
npm run admin -- migrate
npm run admin -- bootstrap --username admin --display-name "운영 관리자"
npm run admin -- change-password --username admin
```

Gateway가 실행된 뒤 관리자가 `/admin/users`에서 개발자와 검토자 계정을 만든다. 개발자에게 `DEVELOPER`, 공유 주소를 여는 사람에게 `REVIEWER`를 부여한다. 새 계정은 브라우저에서 임시 비밀번호 변경을 완료한 뒤 사용한다.

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

4. 설치된 서버에 전용 테스트 계정을 만든 뒤 [외부 HTTPS 브라우저 검사](public-path-testing.md)를 수행한다. Canary는 프록시 경로를, 브라우저 검사는 실제 로그인·공유·화면 갱신을 확인한다. 정식 운영 전에는 [배포 문서](linux-deployment.md)의 백업·복구와 운영 인수 항목도 완료한다.

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

### 핀 표시와 위치

`Hide all pins`는 댓글 목록을 유지한 채 핀을 숨긴다. 댓글의 `Show pin`으로 하나만 표시하고, `Pin #…` 버튼으로 해당 위치까지 이동할 수 있다. `Show all pins`는 불러온 핀을 다시 표시한다. 이 선택은 다른 검토자나 저장된 피드백을 바꾸지 않는다. 전체 표시 설정은 같은 탭의 새로고침 뒤에도 유지되지만 개별 핀 선택은 이동·새로고침 때 초기화된다.

화면 크기가 바뀌어도 새 핀이 요소를 따라가게 하려면 의미가 있는 작은 요소에 고유하고 안정적인 식별자를 지정한다.

```html
<button data-review-id="checkout-submit">주문하기</button>
```

새 선택은 `data-review-id`, 다음으로 `id`를 찾고, 선택 영역 전체가 그 요소 안에 있을 때 요소 기준 위치를 저장한다. 페이지 전체를 감싸는 요소는 제외한다. 식별자가 없거나 중복되거나 요소가 숨겨졌으면 핀을 숨기고 이유를 표시한다. 다른 요소를 임의로 대신 선택하지 않는다.

적합한 식별자가 없는 선택과 기존 핀은 화면 기준의 근사 좌표로 남는다. 점선과 원래 화면 크기를 표시하고, 현재 viewport 폭 또는 문서 크기가 2 CSS 픽셀 넘게 다르면 핀을 숨긴다. 크기가 같다고 내용까지 같다는 보장은 없다. 식별자를 나중에 추가해도 기존 핀은 자동 변환되지 않는다. iframe·Shadow DOM 내부와 텍스트 구간 추적은 지원하지 않는다.

### 리뷰함·알림·재검토

Control 주소의 `/reviews`에서 프로젝트·버전·페이지·상태·작성자로 저장된 피드백을 찾는다. 영구 댓글 링크는 로그인 후 같은 글로 돌아오며 앱 공유가 끝나도 대화를 읽고 허용된 편집을 할 수 있다. `내 알림`은 프로젝트 전체의 멘션·답글·재검토 알림을 모아 수신자에게만 보여 준다.

개발자의 확인 요청과 작성자의 해결 확인·보완 요청은 [리뷰 사용 안내](internal-review-guide.md)를 따른다. 새 재검토 요청에는 migration 19–21과 `REVIEW_WORKFLOW_ENABLED=true`가 필요하다. 기본값은 꺼짐이다.

실시간 갱신·필터 변경·앱 안의 경로 이동 중에는 현재 탭의 초안을 유지한다. 다른 사람이 먼저 수정하면 내 입력을 유지하면서 충돌을 알린다. 새로고침하거나 탭을 닫으면 저장하지 않은 초안은 사라진다.

### Vite와 Next.js integration

먼저 Review Tunnel 저장소 루트에서 패키지를 만든다. `npm pack`은 npm 저장소로 업로드하지 않고 로컬 `.tgz` 파일을 만든다.

```sh
npm pack ./apps/vite-integration
npm pack ./apps/next-integration
```

검토할 **웹앱 프로젝트 폴더**에서 필요한 패키지 하나를 설치한다. 아래 경로는 내려받은 Review Tunnel 저장소의 실제 경로로 바꾼다.

```sh
# Vite 앱
npm install --save-dev /path/to/review-tunnel/review-tunnel-vite-0.1.0.tgz
# Next.js 앱
npm install --save-dev /path/to/review-tunnel/review-tunnel-next-0.1.0.tgz
```

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

`withReviewTunnel()`과 `reviewTunnelScriptProps()`는 기본적으로 `NODE_ENV=production`에서 비활성화된다. 따라서 실제 Next production build의 HTML에는 bootstrap 경로가 들어가지 않는다. Vite plugin도 `apply: "serve"`라 build에는 적용되지 않는다. 두 연동 패키지는 비공개 workspace 의존성 없이 컴파일된 JavaScript·선언 파일·MIT 라이선스를 포함하며, 외부 임시 프로젝트의 tarball 설치·import 검사를 완료 게이트에 포함한다.

위 `nonce`는 앱이 해당 응답의 CSP 헤더에 넣은 것과 같은 요청별 값이어야 한다. CSP를 끄거나 `unsafe-inline`로 약화하는 대신 이 값을 명시적으로 전달한다.

## 어떤 준비가 누구 책임인가

| 역할 | 책임 |
| --- | --- |
| 개발자 | 로컬 앱을 실행하고 계정으로 Client 실행 |
| 검토자 | 공유 URL을 열고 로그인 |
| 운영자 | 서버·DB·DNS·TLS·계정·백업 관리 |
| Review Tunnel | 공유 URL, 인증, 중계, 운영 제어 제공 |

Review Tunnel은 특정 DNS 업체나 클라우드 계정을 대신 만들지 않는다. 운영형의 서버·DB·DNS·TLS는 배포 환경에 맞게 준비한다.

## 자주 만나는 문제

| 증상 | 확인할 것 |
| --- | --- |
| 공유 명령에서 비밀번호 변경 요구 | control host의 `/login`에서 초기 비밀번호를 먼저 변경 |
| 개발자 로그인은 되지만 공유 화면에서 403 | 화면을 보는 계정에 `DEVELOPER` 또는 `REVIEWER` 권한이 있는지 확인 |
| 새로운 공유가 활성화되지 않음 | canary 기록·별도 admission 승인·kill switch·DB 연결 확인 |
| 화면은 열리지만 갱신·스트리밍 실패 | Ingress의 WebSocket Upgrade와 요청·응답 버퍼링 설정을 canary로 검사 |
| Chrome을 찾지 못해 브라우저 검사 실패 | 테스트는 `channel: "chrome"` 사용. [기여 안내](../CONTRIBUTING.md)의 Chrome 설치 명령 실행 |
| 로그아웃시킨 사용자가 다시 들어옴 | 세션 종료는 현재 로그인만 폐기. 계속 차단하려면 계정을 정지하거나 검토자 권한 제거 |
