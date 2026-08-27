# Review Tunnel 공유 기반 기획안

> 개발자의 로컬 웹 애플리케이션을 별도 배포 없이 인증된 검토자에게 공유하는 보안·중계 기반

| 항목 | 내용 |
| --- | --- |
| 문서 상태 | Draft v0.9 — 리뷰 중심 제품 방향과 공유 기반 범위 분리 |
| 제품명 | Review Tunnel(가칭) |
| 대상 독자 | 제품 담당자, 개발자, 인프라·보안 검토자 |
| 문서 목적 | `0.1.0` 공유 기반의 범위, 핵심 흐름, 시스템 경계, 보안 기준과 검증 조건을 기록한다. |

> [!NOTE]
> Review Tunnel의 제품 방향은 “로컬 웹앱을 안전하게 공유하고 화면 위에서 바로 리뷰받는 도구”다. 이 문서의 4~15장은 현재 구현된 안전한 공유 기반을 중심으로 설명한다. 다음 단계인 페이지·영역 댓글, 스레드와 리뷰 버전 설계는 [화면 맥락 리뷰 제품·기술 설계](contextual-review.md)와 [ADR-0006](adr/0006-contextual-review-overlay.md)을 기준으로 한다.

## 1. 배경과 목적

### 1.1 해결하려는 문제

개발 중인 웹 화면을 디자이너나 동료에게 보여주려면 보통 별도 개발 서버에 배포해야 한다. 이 과정은 작은 변경을 검토할 때도 배포 대기, 환경 구성, URL 관리 비용을 만든다. 화면을 공유한 뒤에도 메신저의 “두 번째 카드 버튼” 같은 피드백은 대상 페이지와 영역의 맥락을 쉽게 잃는다.

개발자 PC의 로컬 서버를 다른 네트워크에서 직접 열어 두는 방식은 NAT와 방화벽 환경에서 동작하기 어렵고, 인증 없이 공개하면 프로젝트가 노출될 수 있다.

### 1.2 제품 목적

Review Tunnel은 개발자 PC에서 실행 중인 로컬 개발 서버를 별도 배포 없이 다른 기기의 브라우저에 임시 공유하고, 공유 화면의 페이지와 영역에 연결된 피드백 흐름을 제공하는 것을 제품 목적으로 한다.

Tunnel Client가 배포된 Gateway에 아웃바운드 연결을 만들고 유지하면, Gateway는 관리자 발급 계정으로 인증·인가된 검토자의 HTTPS 요청, streaming 응답과 브라우저 WebSocket 연결을 해당 로컬 서버로 중계한다. 개발자 PC에는 외부 listener를 열지 않는다. 하나의 기준 도메인 아래에 콘텐츠 wildcard와 그 바깥의 control host를 둔다.

`0.1.0`의 공유 대상은 하나의 로컬 origin이다. Review Tunnel은 브라우저가 사용하는 HTTP, HTTP streaming(SSE 포함), WebSocket 동작의 의미를 가능한 한 그대로 보존한다. HTTP 메서드의 이름이나 데이터 변경 여부를 제품이 판단하거나 앱을 읽기 전용으로 만들지 않는다. Gateway의 중계 개입은 인증, 예약 경로·자격 증명 격리, 고정 원본 라우팅, 프로토콜 안전성, 자원 제한과 관찰 가능성에 한정한다. 다음 단계의 리뷰 기능은 별도 예약 API와 격리 오버레이로 추가해 이 중계 경계를 유지한다.

여기서 투명성은 byte-for-byte 전송이나 동일한 네트워크 프로토콜을 뜻하지 않는다. 브라우저와 로컬 개발 서버가 관찰하는 요청·응답·stream·WebSocket 메시지의 의미를 보존한다는 뜻이다.

### 1.3 단계별 성공의 한 문장 정의

- **공유 기반 `0.1.0`:** 개발자가 공유 명령 하나로 임시 URL을 만들고, 관리자 발급 계정으로 인증한 검토자가 화면·API·실시간 갱신을 사용할 수 있다. 개발자가 공유를 종료하면 URL과 장기 연결도 함께 종료된다.
- **다음 리뷰 MVP:** 검토자가 별도 설치 없이 페이지 또는 영역에 댓글을 남기고, 개발자가 답글과 해결 처리를 하며, 댓글이 Tunnel 재생성 후에도 동일 프로젝트·리뷰 버전에 유지된다.

## 2. 목표와 비목표

### 2.1 목표

- 별도 배포 없이 단일 로컬 웹 애플리케이션을 공유한다.
- 개발자는 CLI 한 번으로 공유를 시작하고 종료한다.
- 검토자는 별도 프로그램 설치 없이 브라우저에서 관리자 발급 계정으로 로그인한다.
- 검토자는 공유 화면의 페이지 또는 영역에 피드백을 남기고 개발자와 해결 상태를 공유한다.
- 일반 HTTP, streaming/SSE, 브라우저 WebSocket과 공식 지원 개발 서버의 HMR을 전달한다.
- 인증형 Gateway의 외부 요청은 인증·인가, TLS, 명시적인 프록시 정책을 거친다.
- 인증형 Gateway의 control host와 공유 콘텐츠의 Cookie·Origin 경계를 분리한다.
- 연결·요청·실패 상태를 개발자와 운영자가 확인할 수 있다.
- 핵심 중계 흐름은 작게 유지하고 인증, 저장소, 전송 구현은 교체 가능한 경계로 분리한다.

### 2.2 MVP 비목표

- 범용 TCP, UDP, SSH, 데이터베이스 터널
- WireGuard·VPN, IP·CIDR 라우팅, NAT hole punching과 P2P 연결
- 인터넷에 익명으로 공개하는 URL
- 공유 URL·Tunnel ID·signed URL 또는 URL bearer token의 소지만으로 관리자 발급 계정 인증을 우회하는 링크
- 영구 호스팅 또는 배포 플랫폼 대체
- 여러 로컬 포트의 동시 공유
- 고정 도메인과 영구 URL
- 글로벌 엣지 네트워크, 로드 밸런싱, 다중 리전
- 대용량 파일 전송 최적화
- 범용 프로젝트 관리 대시보드와 조직 단위의 세밀한 초대 권한
- 영구 Site·Resource 카탈로그, 조직별 RBAC와 다중 Connector 관리
- Tunnel마다 Ingress router·인증서·프록시 설정을 동적으로 생성하는 방식
- HTTP/2 wire-level 보존, native gRPC, WebTransport와 QUIC
- 앱을 읽기 전용으로 바꾸거나 경로·메서드·응답 내용을 업무 규칙으로 제한하는 기능

### 2.3 책임 경계

Review Tunnel이 책임지는 영역:

- 누가 Tunnel을 만들고 공유 URL에 접근할 수 있는지 확인
- 하나의 고정된 loopback origin으로 요청과 연결을 라우팅
- HTTP·streaming·WebSocket 의미 보존
- Tunnel과 논리 stream의 수명주기, 취소, 흐름 제어와 자원 제한
- Gateway 소유 자격 증명 격리와 운영 상태 관찰
- 다음 리뷰 단계에서 프로젝트·리뷰 버전별 페이지·영역 댓글, 답글과 해결 상태 관리

로컬 개발 서버가 책임지는 영역:

- 제공하는 경로, HTTP 메서드와 응답 내용
- 디버그 화면, source map, API와 외부 서비스 호출
- 요청이 만드는 데이터 변경과 애플리케이션 자체 인증
- 프레임워크별 개발 서버 설정

Tunnel은 앱의 업무 의미를 판단하거나 바꾸지 않는다. 범용 TCP 터널로 전환하는 CONNECT와 Gateway 예약 host·path는 MVP에서 지원하지 않으며, 그 밖의 proxy·security 변환은 9.2절의 명시된 예외로 한정한다.

개발자가 공유 명령에서 로컬 origin을 지정하는 행위 자체를 그 origin의 앱 동작 전체를 인증된 검토자에게 노출하는 명시적 opt-in으로 본다. 메서드나 데이터 변경 여부마다 추가 확인을 요구하지 않으며 CLI는 선택된 원본과 노출 범위를 공유 시작 시 분명히 표시한다.

## 3. 사용자와 용어

| 용어 | 정의 |
| --- | --- |
| 개발자 | 로컬 앱을 실행하고 공유 세션을 만드는 사용자 |
| 검토자(Reviewer) | 공유 URL을 통해 앱을 확인하는 사용자 |
| 로컬 앱 | 개발자 PC의 루프백 주소에서 HTTP·streaming·WebSocket을 제공하는 개발 서버 origin |
| Tunnel Client | 로컬 앱과 중앙 게이트웨이를 연결하는 개발자용 CLI |
| Tunnel Gateway | 배포된 서버에서 라우팅·세션 관리와 HTTP·streaming·WebSocket 중계를 담당하는 프로세스 |
| Control Plane | 개발자·검토자 인증, 접근 정책, 세션 설정, URL·수명주기와 활성화 판단을 담당하는 Gateway의 논리 영역 |
| Relay Data Plane | 인증된 Session의 HTTP·streaming·WebSocket byte 흐름, 취소와 flow control만 담당하는 Gateway의 논리 영역 |
| Tunnel Session | Client 실행부터 종료 또는 만료까지 유지되는 임시 공유 세션 |
| Tunnel ID | 세션을 라우팅하기 위한 추측하기 어려운 식별자. 접근 권한을 대신하지 않는다. |
| 공유 URL | 검토자가 접속하는 `https://<tunnel-id>.preview.tunnel.example.com` 형식의 주소 |
| 중계 연결(Carrier) | Client가 Gateway에 만드는 지속 WSS 연결. 여러 논리 Stream을 운반한다. |
| `UNBOUND_CARRIER` | Carrier credential은 소비됐지만 `HELLO`가 아직 검증되지 않아 어떤 Session·generation에도 묶이지 않은 연결 상태. 앱 Stream을 운반할 수 없다. |
| Generation | 한 번의 Carrier binding 세대. 활성화 전에는 `candidate`, activation commit 뒤에는 `current`이며 이전·폐기 세대의 메시지는 fence한다. |
| 논리 Stream | 하나의 HTTP 요청·응답, streaming 응답 또는 WebSocket 연결을 중계 연결 안에서 구분하는 단위 |
| 브라우저 WebSocket | 검토자 브라우저와 로컬 앱 사이의 앱 연결. Client–Gateway 중계 연결용 WebSocket과 목적이 다르다. |
| Origin projection | 외부 공유 origin을 로컬 앱이 보게 될 Host·Origin·Referer 값으로 일관되게 투영하는 정책 |
| Session configuration | 고정 로컬 대상의 fingerprint, Origin projection, generation, 제한과 수명 정책을 담는 generation별 불변 snapshot. Session 안에서 단조 증가하는 revision과 digest로 식별한다. |
| Session activation Readiness | Session 상태와 별도로 현재 후보 Carrier·설정 적용·초기 로컬 origin·Relay·route binding 준비 여부를 나타내는 세션별 진단 값 |
| Gateway admission Readiness | pin된 배포 설정과 실제 Ingress의 인증·streaming 경로가 검증되어 새 Session 활성화를 받아들일 수 있는지 나타내는 배포 환경별 전역 값 |
| Carrier credential | 개발자 로그인이 확인된 뒤 Gateway가 WSS 연결 1회를 위해 발급하는 짧은 수명·목적·audience 제한 opaque 자격증명. 공유 URL 접근 권한이나 Resume secret을 대신하지 않는다. |
| Resume secret | 동일한 Tunnel Session을 일시 단절 뒤 복구할 때 Client가 제시하는 고엔트로피 비밀값 |
| 사이트 경계 | 브라우저의 Cookie·SameSite 판단 기준이 되는 등록 가능 도메인(eTLD+1). 다른 서비스와 상위 도메인을 공유할 때는 기존 `Domain` Cookie의 전달 범위를 검토해야 한다. |
| host 경계 | 정확한 hostname 기준 경계. 운영 모드의 control Cookie는 host-only이고 상태 변경은 정확한 control Origin만 허용한다. |
| Project | 여러 Tunnel에 걸쳐 같은 작업물을 식별하는 리뷰 데이터의 안정적인 상위 단위 |
| Review revision | 댓글이 어느 화면 버전을 기준으로 작성됐는지 구분하는 Project 하위 단위. Git commit SHA 또는 명시적인 opaque ID를 사용한다. |
| Review overlay | 검토 대상 앱 위에 toolbar, pin과 댓글 panel을 표시하는 선택적·격리된 브라우저 UI |
| Anchor | 댓글을 page, region 또는 후속 element 위치와 연결하는 구조화된 정보 |

## 4. MVP 전제와 기본 정책

다음은 제품 소유자가 승인한 MVP 기본 정책이다. 계정 운영 수치, 정확한 지원 버전과 인프라 제품처럼 배포 환경에서 확인할 항목은 15장에서 별도로 추적한다.

| 항목 | MVP 기본안 |
| --- | --- |
| 검토자 범위 | 관리자가 `REVIEWER` 권한을 부여한 활성 계정 중 공유 URL을 아는 사용자 |
| 링크 소지 의미 | 공유 URL과 Tunnel ID는 위치 식별자일 뿐이며 계정 인증과 서버 측 권한 정책을 별도로 통과 |
| 개발자 인증 | 관리자가 `DEVELOPER` 권한을 부여한 활성 계정만 Tunnel Session 생성 가능 |
| 계정 운영 | 최초 관리자는 Linux 서버 CLI로 1회 생성하고, 이후 계정은 관리자 웹 UI 또는 인증된 관리자 CLI에서 생성·정지·초기화 |
| 비밀번호 | Argon2id 해시만 PostgreSQL에 저장. 임시 비밀번호는 1회 표시하고 최초 로그인 때 변경 강제 |
| 로그인 세션 | 원문을 저장하지 않는 opaque 세션, 12시간 절대 만료, 계정 정지·권한/비밀번호 변경 때 전체 회수 |
| Carrier 인증 | 개발자 로그인 자격증명을 짧은 수명의 Carrier credential로 교환하고 WSS upgrade에서 사용 |
| 공유 주소 | 하나의 기준 도메인 아래 랜덤 wildcard 서브도메인이며 Control host는 콘텐츠 wildcard 바깥이어야 함 |
| Ingress 라우팅 | 와일드카드 콘텐츠 host 전체를 고정 Gateway로 보내며 Tunnel별 Ingress 설정은 만들지 않음 |
| 로컬 대상 | 기본적으로 `127.0.0.1`, `::1` 또는 검증된 `localhost`의 단일 포트만 허용 |
| 앱 프로토콜 | CONNECT를 제외한 일반 HTTP 메서드, HTTP streaming/SSE와 브라우저 WebSocket을 의미 보존하여 전달 |
| 공유 범위 | 개발자가 명시적으로 선택한 단일 로컬 origin 전체. API와 데이터 변경 요청, streaming/SSE, WebSocket과 HMR을 포함 |
| 세션 수명 | Client 종료, 최대 8시간, 활성 Stream이 없을 때 30분 유휴 만료 중 먼저 도달한 조건에 따라 종료 |
| 일시 단절 | 2분의 재연결 유예 안에 복구하면 동일 URL 유지 |
| 명시적 종료 | `Ctrl+C` 또는 종료 명령을 받으면 즉시 세션 폐기 |
| 콘텐츠 저장 | 요청·응답 본문을 Gateway에 영구 저장하지 않음 |
| 세션 설정 | 작은 불변 snapshot을 revision·digest로 식별하고 Client 적용 확인 뒤 활성화 |
| 초기 공식 지원 | Node.js 24에서 실행되는 Client, Chromium 계열 브라우저, 고정 버전 Vite·Next.js fixture. 정확한 버전은 호환성 매트릭스에서 관리 |
| 배포 형태 | Linux 또는 컨테이너 환경의 단일 Gateway. Control Plane과 Relay Data Plane은 내부 모듈로 분리하고 Registry는 메모리 기반으로 운영 |
| Gateway 재시작 | 기존 Session과 공유 URL 종료를 MVP 제약으로 허용. 자동 복구하거나 새 URL을 자동 발급하지 않음 |

## 5. 핵심 사용자 흐름

### 5.1 공유를 시작한다

1. 개발자가 로컬 앱을 실행한다.
2. 개발자가 공유할 로컬 주소를 지정해 Client를 실행한다.
3. 유효한 자격 증명이 없으면 Client가 관리자 발급 계정 로그인을 유도하고, 성공 후 자동으로 공유 절차를 재개한다.
4. Client는 대상이 허용된 루프백 주소인지 확인하고 로컬 앱의 응답 가능 여부를 점검한다.
5. Client는 개발자 로그인 자격증명을 짧은 수명의 Carrier credential로 교환하고 Gateway에 인증된 중계 연결을 만든다.
6. Gateway는 `CREATING` Session, Tunnel ID, 공유 URL과 revision·digest가 있는 불변 Session configuration을 발급한다. 이 시점의 URL은 아직 라우팅할 수 없다.
7. Client는 설정을 적용하고 로컬 origin 상태를 다시 점검한 뒤 revision·digest와 적용 결과를 Gateway에 확인한다.
8. Gateway는 Carrier의 Relay probe, 비활성 Registry binding과 배포 환경의 Ingress canary 상태까지 확인한 뒤에만 Session을 `ACTIVE`로 바꾼다.
9. Client는 사용 가능한 공유 URL, 인증 정책과 구성 요소별 Readiness를 출력한다.

예시:

    npm run dev
    npm run share -- http://127.0.0.1:3000 --username developer1

    Connected
    Local:  http://127.0.0.1:3000
    Share:  https://4f9a07b6c51e2d83a0b918d5e8c1f234.preview.tunnel.example.com
    Scope:  entire local origin
    Access: administrator-issued account required
    Protocols: HTTP, SSE, WebSocket
    Tunnel protocol: review-tunnel.v1
    Origin projection: local-view
    Readiness: carrier=ready, config=applied, origin=ready, relay=ready

### 5.2 검토자가 화면을 확인한다

1. 검토자가 공유 URL을 연다.
2. 인증 세션이 없으면 로그인 화면으로 이동한다.
3. Gateway는 활성 계정과 `REVIEWER` 권한을 검증한다.
4. Gateway가 Tunnel ID에 대응하는 활성 Client를 찾는다.
5. HTTP 요청, streaming 응답과 WebSocket 연결이 Client를 거쳐 로컬 앱과 연결된다.
6. 로컬 앱의 응답과 실시간 메시지가 같은 경로를 거쳐 검토자 브라우저에 반환된다.
7. 공식 지원 개발 서버에서는 코드 변경이 HMR 또는 Fast Refresh를 통해 자동 반영되고 수동 새로고침도 정상 동작한다.

### 5.3 공유를 종료한다

- 개발자가 명시적으로 Client를 종료하면 Gateway는 현재 연결의 종료 요청을 검증하고 Session을 먼저 라우팅 불가능하게 만든 뒤 열린 Stream을 정리한다. CLI는 Gateway의 종료 확인을 받은 뒤 URL이 폐기됐다고 표시하며, 확인 응답이 유실돼도 URL이 다시 활성화되지는 않는다.
- 네트워크가 일시적으로 끊기면 CLI는 재연결 중임을, 검토자에게는 일시적인 오프라인 상태를 표시한다.
- 연결이 복구되면 같은 URL을 계속 사용한다. 복구할 수 없으면 CLI가 이전 URL의 만료와 공유 명령을 다시 실행해야 한다는 점을 분명히 알린다. 상세 상태 규칙은 8.4절을 따른다.

### 5.4 화면 맥락 리뷰를 수행한다 — 다음 제품 단계

1. 개발자는 stable Project와 Review revision을 지정해 review 모드로 공유한다.
2. 검토자는 공유 URL에서 현재 path의 페이지 댓글과 영역 핀을 확인한다.
3. 검토자는 페이지 전체 또는 클릭한 위치에 댓글을 남긴다.
4. 개발자와 검토자는 같은 스레드에서 답글을 주고받는다.
5. 개발자는 수정 후 스레드를 해결 처리한다.
6. Tunnel ID가 바뀌어도 같은 Project와 Review revision이면 댓글이 유지된다.

이 흐름의 상세 요구사항, 데이터 모델과 인수 기준은 [화면 맥락 리뷰 설계](contextual-review.md)에서 관리한다. 아래 6장부터 15장까지의 MVP 표는 `0.1.0` 공유 기반의 완료 기준이다.

## 6. MVP 요구사항

### 6.1 기능 요구사항

| ID | 요구사항 |
| --- | --- |
| FR-01 | 인증된 Client만 세션을 만들 수 있어야 한다. |
| FR-02 | Client는 기본적으로 루프백 HTTP 주소의 단일 포트만 공유하고, 세션이 활성화된 뒤에는 해당 원본을 바꿀 수 없어야 한다. |
| FR-03 | Gateway는 CSPRNG로 생성한 128-bit lowercase hex Tunnel ID와 HTTPS wildcard URL을 발급한다. |
| FR-04 | HTTP 요청과 WebSocket handshake는 로컬 앱에 전달되기 전에 검토자 인증·인가를 통과해야 한다. |
| FR-05 | Gateway는 파서가 수용한 앱 HTTP 메서드, 최종 상태 코드(101 포함), 앱 헤더, 쿠키와 요청·응답 body를 의미 변경 없이 전달해야 한다. CONNECT는 범용 TCP 기능이므로 MVP에서 지원하지 않는다. |
| FR-06 | Client와 Gateway는 요청·응답 body를 전체 buffering하지 않고 chunk 단위로 전달하고, SSE를 포함한 장시간 HTTP 응답을 즉시 flush해야 한다. |
| FR-07 | Gateway는 인증된 브라우저 WebSocket handshake를 로컬 앱과 연결하고 text·binary 메시지, subprotocol과 close 의미를 양방향으로 전달해야 한다. |
| FR-08 | 한 Tunnel에서 finite HTTP, streaming HTTP와 WebSocket 논리 Stream을 동시에 처리하고 서로의 데이터와 상태를 정확히 분리해야 한다. |
| FR-09 | Client와 Gateway는 heartbeat로 중계 연결 상태를 확인하고, 일시 단절 시 제한된 재연결을 수행해야 한다. |
| FR-10 | 명시적 종료, 연결 단절, 세션 만료와 각 논리 Stream의 종료·취소를 서로 다른 상태로 관리해야 한다. |
| FR-11 | 로컬 앱 중단, handshake 실패, 세션 단절, 유형별 timeout, 크기·buffer 제한 초과를 구분해 응답해야 한다. |
| FR-12 | 개발자는 CLI에서 공유 URL, 지원 프로토콜, 현재 상태, 활성 Stream 수, 재연결 여부와 실패 원인을 확인할 수 있어야 한다. |
| FR-13 | 운영자는 payload나 인증 정보를 저장하지 않고 세션·Stream 상태, 응답 코드, close 원인, 지연과 오류를 관찰할 수 있어야 한다. |
| FR-14 | Gateway는 세션별 불변 Session configuration을 revision·digest로 발급하고, create이면 Resume secret 수신 receipt까지 포함해 Client가 동일한 activation material을 적용·보관했다고 확인하기 전에는 Session을 `ACTIVE`로 만들지 않아야 한다. |
| FR-15 | `ACTIVE` 진입은 Client 인증, candidate generation의 Carrier, 설정 적용, 로컬 origin 점검, Relay probe와 활성화 가능한 Registry binding으로 구성된 Session activation Readiness, 그리고 Gateway admission Readiness를 모두 만족해야 한다. 한 항목의 실패를 다른 항목의 성공으로 숨기지 않는다. |
| FR-16 | 인증형 Gateway의 공유 콘텐츠 wildcard host는 고정 Ingress 경로로 전달하고, Tunnel 생성·종료 때 Ingress router·인증서·플러그인 설정을 생성하거나 제거하지 않아야 한다. |
| FR-17 | 인증형 Gateway의 Carrier credential은 짧은 수명과 전용 purpose·audience를 가져야 하며 URI·query에 넣지 않는다. Gateway는 Resume secret과 재사용 가능한 bearer secret의 원문을 저장하지 않고 용도별 HMAC lookup 값만 유지해야 한다. |

### 6.2 호환 범위

MVP가 보장해야 하는 범위:

- macOS arm64에서 실행되는 Tunnel Client
- 자동 호환성 검사를 통과한 Chromium 계열 브라우저
- HTML, CSS, JavaScript, JSON, 이미지, 폰트와 기타 바이너리 자산
- CONNECT를 제외하고 표준 HTTP 파서가 수용하는 앱 요청 메서드
- chunk 단위 요청 body와 finite·streaming 응답 body
- 앱이 사용하는 일반 쿠키와 리다이렉트
- 압축 응답과 여러 동시 요청
- SSE와 그 밖의 장시간 HTTP streaming
- 브라우저 WebSocket text·binary 메시지, subprotocol과 close
- 호환성 매트릭스에 고정한 Vite·Next.js 버전의 HMR·Fast Refresh. 정확한 Node·bundler·브라우저·프레임워크 버전은 빌드 목록에서 관리
- 코드 변경 자동 반영과 수동 새로고침

MVP가 보장하지 않는 범위:

- 설정된 상한을 넘는 업로드·다운로드
- 로컬 앱이 생성한 모든 절대 URL의 자동 교정
- 모든 개발 프레임워크와 플러그인의 무수정 호환
- raw TCP, HTTP/2 wire semantics, native gRPC와 WebTransport
- WebSocket 101을 제외한 informational 1xx 응답, HTTP request·response trailer와 `Expect: 100-continue`의 end-to-end 보존. MVP는 이 동작을 호환 범위로 선언하지 않는다.

### 6.3 비기능 요구사항

| 영역 | 요구사항 |
| --- | --- |
| 보안 | Gateway의 외부 구간은 HTTPS/WSS만 사용하고 검토자와 Client 인증을 분리한다. |
| 개인정보 | 요청·응답 본문, Cookie, Authorization 값을 로그나 영구 저장소에 남기지 않는다. |
| 의미 투명성 | 앱 메서드·header·body·stream·WebSocket 메시지의 관찰 가능한 의미를 보존하고 앱 정책을 대신 판단하지 않는다. |
| 신뢰성 | Stream은 중복되거나 서로 섞이지 않아야 하며, 재연결 때 자동 replay하지 않고 실패를 숨기지 않는다. |
| 흐름 제어 | 느린 수신자가 전체 Tunnel의 메모리를 고갈시키거나 다른 Stream을 무기한 막지 않아야 한다. |
| 성능 | Gateway가 추가하는 first-byte·message 지연, 동시 Stream 수와 전송량을 측정하고 파일럿 전에 목표치를 확정한다. |
| 운영성 | 모든 논리 Stream은 Stream ID로 Gateway와 Client 로그를 연결할 수 있어야 한다. |
| 구성 일관성 | Control Plane의 desired revision과 Client의 applied revision·digest가 일치하고 실제 Relay probe가 성공해야 요청을 받을 수 있어야 한다. |
| 배포 안전성 | Ingress·Load Balancer와 필수 플러그인·라이브러리 버전을 고정하고 실제 공개 경로 canary와 롤백 기준을 운영한다. |
| 변경 용이성 | 인증 제공자, 세션 저장소, 중계 전송과 TLS 종료 방식은 핵심 라우팅 규칙과 분리한다. |
| 호환성 | 파일럿 대상 프레임워크별 E2E 테스트를 통과한 조합만 공식 지원으로 표시한다. |

## 7. 시스템 구조와 책임 경계

### 7.1 컨텍스트

인증형 Gateway:

    검토자 브라우저
          │ HTTPS / WSS
          ▼
    고정 Wildcard Ingress / TLS  ◀── public-path canary
          │ 모든 콘텐츠 host를 동일 Gateway로 전달
          ▼
    ┌──────────────────────────────────────────┐
    │ Tunnel Gateway                           │
    │                                          │
    │  Control Plane                           │
    │  인증·접근 정책 ─ Session Coordinator    │
    │                     │                    │
    │              Session Registry            │
    │          Session Config / Readiness      │
    │                     │                    │
    │  Relay Data Plane                        │
    │  Public Ingress Adapter ─ Relay Core     │
    │                          Stream Mux       │
    └──────────────────────────┬───────────────┘
                               │ WSS Carrier
                               │ 개발자 PC에서 시작한 연결
                               ▼
                        ┌───────────────┐
                        │ Tunnel Client │
                        └───────┬───────┘
                                │ HTTP / WebSocket
                                ▼
                        127.0.0.1:3000

          PostgreSQL 계정 저장소 ──────▶ Control Plane

### 7.2 구성 요소별 책임

#### Tunnel Client

- CLI 입력과 로컬 대상 검증
- 개발자 자격 증명을 짧은 수명의 Carrier credential로 교환하고 Gateway에 WSS 연결
- Session configuration의 revision·digest 검증, 적용과 결과 확인
- 로컬 앱 상태 점검
- HTTP 요청 body와 finite·streaming 응답을 chunk 단위로 중계
- 유효한 WebSocket upgrade를 로컬 서버와 연결하고 upgrade 이후 byte stream 중계
- heartbeat, backpressure, 취소, 재연결과 종료 처리
- Carrier·설정·로컬 origin·Relay Readiness와 개발자용 상태·오류 출력

Client는 임의의 사설망 호스트를 기본값으로 허용하지 않는다. 루프백 외 주소는 MVP 이후 별도 opt-in 정책과 위험 안내가 있을 때만 고려한다.

Client는 `localhost`를 사용할 때 health probe에서 모든 해석 결과가 loopback인지 검증하고 실제로 연결된 IP literal을 세션 동안 고정한다. 각 중계 요청의 URL은 이 고정 origin의 상대 경로로 해석하며, 요청에 포함된 절대 URL이나 Host 값으로 대상 호스트·포트를 바꾸지 않는다. Health probe와 실제 중계 HTTP Client는 redirect를 자동 추적하지 않고 3xx 응답을 브라우저로 반환한다.

#### Tunnel Gateway

- 고정 Ingress의 HTTPS·WebSocket upgrade와 Client WSS 수신
- Control Plane과 Relay Data Plane의 포트·의존성 조립
- 공통 설정, 오류 응답, 로그, 메트릭과 graceful shutdown 제공

#### Control Plane

- 개발자·Client 인증과 짧은 수명의 Carrier credential 발급·검증
- 검토자용 관리자 발급 계정 인증 및 `REVIEWER` 접근 정책 적용
- 불변 Session configuration 생성과 desired revision·digest 관리
- Client의 적용 확인, 로컬 origin 결과와 Relay probe로 Session activation Readiness를 판정하고 전역 Gateway admission Readiness와 결합
- Tunnel Session·generation·lease·Resume·종료 수명주기 관리
- Tunnel ID 기반 비활성 binding 예약, route의 원자적 활성화·비활성화와 감사 이벤트 생성

Control Plane은 애플리케이션 body나 WebSocket byte를 해석하지 않으며 Relay Data Plane의 구현 세부사항으로 신원·접근 정책을 판단하지 않는다.

#### Relay Data Plane

- Control Plane이 `ACTIVE`로 승인한 Session의 HTTP·streaming·WebSocket 트래픽만 수신
- Tunnel ID와 현재 generation에 바인딩된 Carrier로 논리 Stream 전달
- 여러 Stream의 multiplexing, 공정한 scheduling, flow control, 취소와 유형별 자원 제한 적용
- 응답 시작 여부에 맞는 오류 변환과 Stream lifecycle 메타데이터 생성

Relay Data Plane은 Session을 발급하거나 인증을 우회할 수 없다. 접근 결정은 Control Plane이 만든 검증된 context만 입력으로 사용한다.

#### Relay Core

- finite HTTP, HTTP streaming과 WebSocket upgrade를 공통 논리 Stream 모델로 관리
- `open → data → half-close/end/cancel/error` 상태 전이와 Stream ID 상관관계 보장
- WebSocket 101 전에는 HTTP handshake로 처리하고, 101 후에는 양방향 opaque byte stream으로 전환
- Stream별 bounded queue와 flow-control credit 적용
- 하나의 큰 Stream이 heartbeat나 다른 Stream을 계속 막지 않도록 공정하게 chunk scheduling
- 중계 연결이 끊기면 열린 Stream을 종료하고 자동 replay하지 않음

SSE는 별도 도메인 파이프라인이 아니라 종료가 늦는 HTTP response stream으로 처리한다. HMR도 Relay Core의 별도 기능이 아니라 HTTP streaming과 WebSocket 의미 보존을 공식 개발 서버에서 검증하는 호환성 기준이다.

#### Session Registry

- Tunnel ID, 소유자, 현재 generation·Carrier, 상태, lease 만료 시각의 대응 관계 관리
- desired·applied configuration revision·digest와 Session activation Readiness 관리
- Resume secret 원문 대신 서버 비밀키로 만든 HMAC lookup 값과 폐기 여부만 관리
- 원자적인 생성, 조회, 상태 전이와 제거 제공
- MVP에서는 Gateway 프로세스 메모리에 두며 애플리케이션 콘텐츠는 저장하지 않음

#### Account·Authentication 모듈

이 모듈은 인증형 Gateway에서만 사용한다.

- `ADMIN`, `DEVELOPER`, `REVIEWER` 권한을 가진 관리자 발급 계정과 로그인 세션을 관리
- 공개 회원가입 없이 관리자만 계정을 생성하고, 일회용 임시 비밀번호의 최초 변경을 강제
- 비밀번호 해시, 계정·권한, 로그인 제한, 세션과 감사 이벤트는 PostgreSQL 저장소 포트를 통해 영구 보관
- 계정 정지, 비밀번호 초기화와 권한 변경 때 대상 계정의 세션과 열린 Tunnel·Stream을 회수
- 비밀번호 구현과 저장소 구현을 Relay Core 및 UI에서 분리

#### Review API·Overlay — 다음 제품 단계

- stable Project와 Review revision을 Tunnel Session과 별도 수명주기로 관리
- 페이지 댓글, 영역 anchor, 답글과 해결 상태를 PostgreSQL에 저장
- 콘텐츠 host의 `/_review-tunnel/review/*` 예약 경로에서 인증된 API와 SSE 제공
- 개발 서버 integration이 명시적으로 활성화한 Shadow DOM 오버레이 렌더링
- 앱 Cookie·body·DOM 전체·화면 이미지를 자동 수집하지 않는 데이터 경계 유지
- review 모드가 꺼졌거나 오버레이 로딩이 실패해도 Relay Data Plane의 앱 중계는 그대로 유지

Review API는 앱 트래픽을 운반하는 `review-tunnel.v1` Carrier에 댓글 메시지를 추가하지 않는다. Tunnel ID는 현재 Review revision을 가리키는 임시 binding일 뿐 댓글의 영속 식별자가 아니다. 상세 결정은 [ADR-0006](adr/0006-contextual-review-overlay.md)을 따른다.

#### DNS·TLS 경계

이 경계는 인증형 Gateway에서만 사용한다.

- `*.preview.tunnel.example.com` 형태의 공유용 와일드카드 DNS 및 인증서 제공
- `control.tunnel.example.com` 형태의 로그인·관리자 UI·Client WSS endpoint 제공
- 두 이름은 하나의 기준 도메인 아래에 둔다. 어떤 기준 도메인을 사용할지는 운영자가 정한다. 실제 content·control host는 환경 설정 adapter에서 읽는다. Gateway는 시작할 때 control host가 콘텐츠 wildcard namespace 바깥인지, 예약 host·path 충돌과 HTTPS scheme 불변식을 검증하고 실패하면 트래픽을 받지 않는다.
- 도메인 이름과 공개 endpoint 같은 비밀이 아닌 값은 환경 변수로 주입하되 DB 자격증명과 HMAC key는 환경별 secret manager 또는 동등한 비밀 주입 경계에서 가져온다.
- 콘텐츠 와일드카드 host 전체를 하나의 고정 Gateway upstream으로 전달하고 Tunnel별 router·인증서·middleware 설정을 만들지 않음
- 각 Tunnel host에서 `/_review-tunnel/*` 예약 인증 경로를 Gateway가 직접 처리
- 다른 서비스와 상위 도메인을 공유할 때는 기존 `Domain` Cookie의 전달 범위를 검토한다. 인증형 Gateway 안에서는 control host를 콘텐츠 wildcard 바깥에 두고 host-only Cookie와 정확한 Origin 검증으로 제어 경계를 유지한다.
- MVP는 승인된 기존 Ingress·Load Balancer 앞단에서 TLS를 종료하고 Gateway는 해당 경로에서 온 연결만 수신
- 앞단 프록시가 WebSocket Upgrade, streaming no-buffer·즉시 flush, 충분한 장기 연결 timeout과 client cancellation 전달을 지원
- 앞단 Ingress와 Load Balancer가 request body 선행 buffering, response buffering과 shared cache를 비활성화하고 첫 request chunk를 전체 upload 종료 전에 Gateway로 전달
- Ingress·Load Balancer와 필수 플러그인 버전을 floating tag 없이 고정하고, 배포 전후 실제 콘텐츠 도메인의 public-path canary와 명시적인 배포 차단·롤백 판단 기준 운영
- canary는 두 경로로 나눈다. 외부의 미인증 negative probe는 실제 DNS·TLS·Load Balancer·Ingress를 거쳐 인증 장벽에서 차단되는지 확인하고, 별도의 synthetic 검토자 자격 또는 네트워크 제한을 적용한 authenticated fixture는 request streaming, SSE no-buffer와 WebSocket Upgrade를 확인한다.
- 예약 canary host는 Tunnel ID namespace와 분리하고 strict rate limit을 적용한다. fixture는 Tunnel·사용자 payload를 사용하거나 반환하지 않으며 익명 우회 endpoint가 되어서는 안 된다. 두 canary 모두 Session activation이나 `gateway_admission_ready`에 의존하지 않아 순환 판정을 만들지 않는다.
- canary 결과와 admission 승인은 `(deployment_id, config_digest)`별 PostgreSQL record로 분리한다. 성공 probe가 승인을 자동 생성하지 않으며 명시적 관리자·배포 파이프라인 승인 뒤에만 해당 identity의 신규 Session을 연다. 실패는 그 identity의 승인을 제거하고 전역 kill switch도 PostgreSQL에 영속한다.
- Gateway 콘텐츠 listener를 승인된 Ingress source로 제한하고, Ingress가 외부 `Forwarded`·`X-Forwarded-*`를 제거한 뒤 검증한 값을 재작성함
- Ingress·WAF·CDN·APM 등 실제 앞단 계층에 원문 URI, query, Cookie와 Authorization 비수집 정책 적용
- 구체적인 제품 선택은 배포 환경이 정해진 뒤 결정

### 7.3 내부 설계 원칙

- Control Plane과 Relay Data Plane은 책임과 의존성 방향을 분리하되 초기에는 Gateway 하나의 배포 단위로 유지한다. 책임 경계가 있다는 이유만으로 마이크로서비스로 나누지 않는다.
- 배포 환경별 Load Balancer·Ingress·secret manager 차이는 adapter와 설정에만 둔다. Control Plane의 제품 정책과 Relay Core는 특정 클라우드 SDK나 Ingress 제품에 의존하지 않는다.
- Control Plane은 신원·정책·Session configuration과 수명주기를 소유하고 Relay Data Plane은 검증된 context와 Stream만 소비한다. Data Plane에서 Session·권한을 생성하거나 Control Plane이 앱 payload에 의존하는 역방향 의존을 금지한다.
- Tunnel·Stream 상태 전이, 접근 허용 판단, 라우팅 선택, 헤더 정책과 protocol profile 검증은 가능한 한 순수 함수로 구현한다.
- 네트워크, PostgreSQL, 비밀번호 해시, 시계, ID 생성과 세션 저장처럼 부수효과가 있는 동작은 명시적인 경계에 둔다.
- Relay Core는 `RelayTransport` 경계를 통해 고정된 `review-tunnel.v1` 계약을 사용한다. 기존 multiplexing·flow-control 라이브러리를 조합하든 필요한 framing을 직접 구현하든 Tunnel·Stream 상태기계, 인증과 프록시 정책은 선택한 구현 라이브러리에 의존하지 않는다.
- 교체 가능한 구현이 실제로 존재하는 경계에만 인터페이스를 둔다. 단순 변환 로직은 함수로 유지한다.
- Relay Core는 Vite·Next.js를 알지 않는다. 프레임워크 호환은 E2E 테스트와 꼭 필요한 명시적 설정으로 관리하고 핵심 흐름에 프레임워크 이름별 조건문을 넣지 않는다.
- 설정값과 운영 정책은 코드의 숨은 상수가 아니라 검증 가능한 명시적 설정으로 노출한다.
- MVP의 Session configuration은 candidate generation에 발급하고 current 승격 뒤에도 바꾸지 않는 작은 snapshot으로 유지한다. resume으로 candidate generation이 바뀌면 새 revision의 전체 snapshot을 발급한다. 범용 설정 bus, delta patch와 eventually-consistent 배포를 만들지 않는다. 동일 snapshot의 ACK timeout에만 한 번 재전송하고 digest 불일치·명시적 적용 실패는 fail-closed한다.
- Ingress는 세션의 존재를 알지 않는다. 와일드카드 host를 Gateway로 보내는 고정 경계로 유지하고 Session의 생성·삭제는 Registry의 원자적 route 변경만으로 처리한다.
- Gateway 재시작 시 메모리 세션은 사라진다. Client는 resume 실패와 이전 URL의 폐기를 출력한 뒤 종료하며, 사용자가 공유 명령을 다시 실행해야 한다. 이를 운영상 허용 가능한 MVP 제약으로 기록한다.

## 8. 핵심 동작

### 8.1 세션 생성

1. Client가 CLI 입력을 정규화하고 루프백 대상인지 확인한다.
2. Client가 로컬 앱에 제한된 health probe를 보낸다.
3. Client가 개발자 로그인 context로 control API에 인증하고 목적이 `create` 또는 `resume`인 짧은 수명·1회용 Carrier credential을 요청한다.
4. Client가 WSS HTTP upgrade의 `Authorization` header로 Carrier credential을 제시하고 `review-tunnel.v1` subprotocol을 요청한다. URI·query·Cookie·subprotocol payload에는 자격증명을 넣지 않는다.
5. Gateway가 자격증명의 audience·목적·만료·미사용 상태와 subprotocol을 검증한다. Registry의 `unused → consumed` CAS와 `UNBOUND_CARRIER` 할당을 하나의 로컬 원자 연산으로 먼저 확정한 뒤 WSS upgrade를 수락한다. 이후 `101` 전달이 유실되더라도 credential은 소비된 상태로 유지하며 Client는 재시도 전에 새 credential을 발급받는다. 소비 전 검증 실패는 Carrier를 만들지 않고 `401`, `403` 또는 protocol mismatch 응답으로 거부한다.
6. WSS가 성립한 뒤 `HELLO`의 v1 profile, create/resume 정보, canonical local-origin fingerprint와 요청한 Origin projection을 검증한다. resume은 새 `purpose=resume` Carrier credential, 현재 개발자 신원, Resume secret과 기존 Session에 묶인 동일 fingerprint·projection을 모두 요구한다. v1 일부만 구현한 Client는 `CONNECTION_ERROR`로 알리고 연결을 닫는다.
7. Gateway는 create 시 `CREATING` provisional Session과 Tunnel ID·공유 URL을 예약하고, resume 시 기존 Session에 단 하나의 새 candidate generation을 CAS로 만든다. `HELLO`를 검증한 `UNBOUND_CARRIER`를 이 provisional Session 또는 candidate generation에 원자적으로 묶는다. create에서는 config digest에 포함하지 않는 `SESSION_PROVISIONED(provision_id, Session ID, Tunnel ID, 공유 URL, Resume secret)`을 한 번 먼저 보내고, 이어 candidate generation, 로컬 대상 fingerprint, Origin projection, 제한과 수명 정책을 담은 불변 `SESSION_CONFIG(revision, digest)` snapshot을 보낸다. 실제 사설 주소는 외부에 공개하지 않는다.
8. Client는 create이면 Resume secret을 프로세스 메모리에 보관한 뒤 candidate generation의 전체 snapshot을 검증·적용하고 로컬 origin을 다시 점검한다. 이어 `CONFIG_APPLIED(generation, revision, digest, result, provision_receipt?)`를 보내며 create의 receipt에는 수신한 `provision_id`를 포함한다. Gateway는 정확한 receipt를 확인한 뒤 Resume secret 원문의 bounded transient buffer를 해제한다. delta patch나 추측한 기본값으로 불일치를 덮지 않는다.
9. Gateway는 candidate generation의 desired·applied revision과 digest가 일치하는지 확인하고, 같은 candidate Carrier의 데이터 처리 경로를 통과하는 bounded Relay probe를 수행한다. Tunnel ID·candidate generation에 묶인 비활성 Registry binding과 배포 환경의 최신 public-path Ingress canary도 준비돼 있어야 한다.
10. 모든 Readiness가 충족되면 Gateway는 per-Session ordered writer의 닫힌 activation barrier에 `SESSION_ACTIVE`를 먼저 예약한다. 이어 candidate generation의 current 승격, Registry route 등록과 `ACTIVE` 전이를 하나의 원자 연산으로 확정하고 barrier를 해제한다. commit 실패 시 예약한 통지는 폐기한다.
11. Data Plane은 `SESSION_ACTIVE`가 같은 Carrier의 FIFO writer에 선행 예약된 뒤에만 해당 Session의 `OPEN_HTTP` 생성을 허용한다. Client는 ordered dispatcher에서 `SESSION_ACTIVE`를 먼저 처리한 뒤 활성 상태, 공유 URL, 구성 요소별 Readiness와 protocol profile을 출력하고 이후 앱 Stream을 받는다.

local-origin fingerprint는 resume 때 대상이 우연히 바뀌는 것을 막기 위한 Session binding 값이다. Gateway가 개발자 PC의 loopback 여부를 독립적으로 증명한다는 뜻은 아니며, 실제 주소 정규화·loopback 검증과 고정 대상 연결은 Client의 `LocalOriginAdapter`가 책임진다.

### 8.2 HTTP와 streaming/SSE 중계

    검토자        Gateway          Client          로컬 앱
       │              │               │               │
       │─ HTTPS/HTTP ─▶│               │               │
       │              │ 인증/route    │               │
       │              │ 세션 조회     │               │
       │              │ 헤더 정책     │               │
       │              │── open/data ─▶│               │
       │              │               │── HTTP ──────▶│
       │              │               │◀─ head/data ─│
       │              │◀─ head/data ─│               │
       │◀─ head/data ─│               │               │

세부 순서:

1. Gateway는 앞단 TLS와 검토자 인증을 확인한다.
2. 접근 정책을 통과한 요청의 host에서 Tunnel ID를 해석한다.
3. 활성 Session을 찾고 Stream ID를 만든다.
4. Gateway 소유 인증 정보와 hop-by-hop 헤더를 제거하고 신뢰할 수 있는 프록시 헤더를 설정한다.
5. 요청 head와 body chunk를 중계 연결로 Client에 전달한다.
6. Client가 로컬 HTTP 요청을 수행하고 browser cancellation을 로컬 request abort로 전달한다.
7. Client가 response head를 먼저 보낸 뒤 body가 도착하는 순서대로 Stream ID에 맞춰 chunk를 반환한다.
8. Gateway는 전체 body를 기다리지 않고 각 chunk를 브라우저에 쓰고 flush한다.
9. finite response는 `end`에서 닫는다. SSE와 streaming response는 로컬 서버 또는 브라우저가 끝낼 때까지 열어 둔다.
10. SSE의 `Last-Event-ID`는 앱 header로 전달하지만 Relay가 event를 저장하거나 replay하지 않는다.
11. Stream 종료 결과와 지연·전송량 메타데이터만 기록한다.

### 8.3 브라우저 WebSocket 중계

1. 브라우저가 공유 URL에 `Upgrade: websocket` handshake를 보낸다.
2. Gateway가 upgrade를 수락하기 전에 검토자 인증·인가, Session 조회와 자원 제한을 확인한다.
3. Gateway가 자기 인증 쿠키와 내부 header를 제거하고 Host·Origin 정책을 적용한 뒤 `websocket-open` Stream을 Client에 보낸다.
4. Client가 고정된 로컬 origin으로 WebSocket handshake를 보낸다.
5. 로컬 서버가 유효한 `101 Switching Protocols`를 반환한 경우에만 Gateway가 브라우저 upgrade를 완료한다.
6. 이후 Gateway와 Client는 내부 WebSocket frame을 해석·재조립하지 않고 해당 Stream의 양방향 opaque byte로 중계한다.
7. 이 방식으로 text·binary, fragmentation, compression, ping/pong, subprotocol과 정상 close 의미를 브라우저와 로컬 서버 사이에 보존한다.
8. 브라우저 또는 로컬 socket의 정상 EOF는 해당 raw 방향의 `END_STREAM`으로 전달하고, 반대 방향은 close 응답과 남은 byte를 보낼 수 있도록 유지한다. 양방향 EOF 또는 close timeout에서 정상 완료한다. socket 오류, cancellation, timeout과 protocol 위반만 `RESET_STREAM`으로 양쪽을 즉시 중단한다.
9. inner WebSocket close frame은 해석하지 않고 일반 opaque `DATA`로 전달한다. 중계 연결이 끊기면 기존 WebSocket은 종료하고 replay·resume하지 않는다.

Client–Gateway Carrier heartbeat와 브라우저 앱 WebSocket의 ping/pong은 서로 다른 연결의 동작이며 대체 관계가 아니다.

### 8.4 세션 상태

| 상태 | 의미 | 진입 조건 | 다음 상태 |
| --- | --- | --- | --- |
| `CREATING` | 인증과 등록 진행 중 | Client 연결 시작 | `ACTIVE`, `CLOSED` |
| `ACTIVE` | activation gate를 통과한 current generation과 route가 바인딩되어 요청 중계 가능 | 초기 활성화 또는 재연결 commit 성공 | `RECONNECTING`, `CLOSED`, `EXPIRED` |
| `RECONNECTING` | 일시 단절 유예 중 | 예기치 않은 연결 종료 | `ACTIVE`, `EXPIRED`, `CLOSED` |
| `CLOSED` | 명시적 종료 또는 resume 불가능한 fatal 실패로 닫힘 | `CLOSE_SESSION` 또는 fatal control·protocol·security 오류 | 종료 상태 |
| `EXPIRED` | lease, 최대 TTL, 유휴 또는 재연결 유예 만료 | 시간 정책 도달 | 종료 상태 |

상태 전이는 한 곳에서 정의하고 단위 테스트로 보호한다. `CLOSED`와 `EXPIRED` 세션은 라우팅할 수 없으며 Resume secret도 재사용할 수 없다.

Session lifecycle enum을 세부 장애마다 늘리지 않고 다음 Session activation Readiness 값을 별도로 관리한다.

| Readiness | 준비 조건 | 실패 시 의미 |
| --- | --- | --- |
| `control_authenticated` | candidate Carrier credential과 개발자 신원 검증 완료 | candidate Carrier만 거부. current 개발자 권한 회수는 별도 Control Plane terminal 이벤트 |
| `carrier_alive` | candidate generation의 Carrier와 activation heartbeat가 유효 | `CREATING` 유지 또는 `RECONNECTING` |
| `config_applied` | desired·applied revision과 digest가 정확히 일치 | ACK timeout이면 동일 snapshot 1회 재전송. stale generation·digest mismatch·적용 실패면 candidate Carrier 종료 |
| `initial_origin_ready` | Client가 활성화 직전 고정 loopback origin을 재검증하고 연결 가능 결과 보고 | 활성화 거부, CLI에 로컬 서버 오류 표시 |
| `relay_probe_ok` | candidate Carrier의 framing·scheduler·flow-control 경로를 통과한 bounded probe 성공 | 활성화 거부, Data Plane 오류 표시 |
| `route_binding_ready` | Tunnel ID와 candidate generation에 묶인 비활성 Registry binding이 충돌 없이 예약됨 | current route로 원자 승격할 수 없음 |

`session_activation_ready`는 위 값의 논리곱이다. 별도의 전역 `gateway_admission_ready`는 pin된 version·config digest와 실제 콘텐츠 도메인의 미인증 차단 negative probe, 인증된 streaming·Upgrade canary가 모두 최신 배포에서 성공했을 때만 true다. 이 값은 Session Registry에 복제하지 않고 배포 admission 상태로 한 번 관리한다.

최종 `activation_ready = session_activation_ready && gateway_admission_ready`이며 `CREATING` 또는 `RECONNECTING`에서 `ACTIVE`로 들어가는 순간 반드시 true여야 한다. 일부 값이 false인 상태를 사용 가능하다고 표시하지 않으며, CLI·로그·메트릭은 lifecycle 상태, Session readiness와 Gateway admission 실패를 구분해 노출한다. candidate binding을 current route로 승격하는 동작과 `ACTIVE` 전이는 하나의 원자적 Registry 연산으로 처리해 활성 표시와 실제 라우팅이 어긋나지 않게 한다.

Session activation Readiness는 상태 진입을 위한 candidate snapshot이다. `ACTIVE` 뒤의 runtime origin health와 전역 Gateway admission은 별도 운영 진단값이며, 가용성 저하만으로 이미 활성인 Session lifecycle을 자동 변경하지 않는다. current 개발자 권한 회수, current Carrier 단절과 terminal protocol 오류는 아래 수명주기 규칙대로 별도 전이를 만든다.

활성화 뒤 로컬 개발 서버가 일시적으로 응답하지 않는 것은 Carrier 단절이 아니므로 Session을 `RECONNECTING`으로 바꾸지 않는다. Session은 `ACTIVE`를 유지하되 runtime origin health를 `DEGRADED`로 관찰하고 새 요청에는 11.1절의 `502`·`504` 정책을 적용한다. Ingress canary가 활성화 뒤 실패하면 신규 Session 활성화를 멈추고 운영 알림과 rollback 판단을 시작한다. 단일 Gateway·메모리 Registry인 MVP에서는 가용성 canary 실패만으로 프로세스를 자동 교체하지 않는다. 수동 rollback이 재시작을 요구하면 기존 Session·URL이 사라짐을 운영자와 사용자에게 알리고 drain 또는 즉시 중단을 선택한다. 인증 우회 가능성이 있는 실패는 기존 Session까지 kill switch로 fail-closed한 뒤 긴급 rollback한다.

모든 terminal 전이는 `close_reason`을 남긴다. 최소 분류는 `USER_REQUEST`, `FATAL_PROTOCOL`, `FATAL_AUTH`, `MAX_TTL`, `IDLE_TIMEOUT`, `RECONNECT_TIMEOUT`이며 CLI·로그·메트릭은 상태와 원인을 함께 표시한다.

- `ACTIVE` 상태만 새 요청을 중계한다.
- 예기치 않은 연결 단절 시 열린 finite HTTP, streaming/SSE와 WebSocket을 명시적으로 종료하고 자동 replay하지 않는다.
- 활성화 전에는 `SESSION_PROVISIONED`·`SESSION_CONFIG`·`CONFIG_APPLIED`, activation heartbeat, `OPEN_PROBE`와 그 probe Stream ID에 한정된 `DATA`·`END_STREAM`·`WINDOW_UPDATE`·`RESET_STREAM`, 그리고 candidate를 current로 전이시키는 `SESSION_ACTIVE`만 candidate generation에서 허용한다. connection-level 오류는 언제든 허용하되 앱 Stream의 `OPEN_HTTP`·DATA는 금지한다. candidate heartbeat는 activation timeout과 candidate Carrier liveness만 갱신하고 Session lease는 갱신하지 않는다.
- `SESSION_ACTIVE` commit은 candidate generation과 Carrier를 current로 원자 승격한다. 승격 뒤 `OPEN_HTTP`, 앱 Stream 메시지와 Session lease를 갱신하는 heartbeat는 current generation에서만 허용한다. 이전 current generation과 폐기된 candidate generation의 heartbeat, window update, Stream reset과 Session close를 모두 fence·계수하며 이전 generation의 종료 요청이 현재 Session을 닫을 수 없다.
- Session에는 candidate generation을 하나만 허용한다. `(state=RECONNECTING, current_generation, candidate_absent)` CAS의 첫 resume 시도만 후보가 되고, 동시 후속 시도는 기존 candidate나 current Session을 바꾸지 않은 채 `RESUME_IN_PROGRESS`로 Carrier를 닫는다. 후보가 실패해 폐기되면 재연결 유예 안에서 다음 시도가 새 candidate를 만들 수 있다.
- 고엔트로피 Resume secret은 개발자 신원과 Session에 바인딩해 세션 수명 동안 유지한다. Client는 원문을 프로세스 메모리에만 보관하고 Gateway는 용도별 서버 키로 만든 HMAC lookup 값만 보관하며 종료·만료 시 폐기한다.
- 동일 URL 복구는 같은 Gateway 프로세스의 Registry entry가 유예 시간 동안 남아 있을 때만 가능하다.
- 최대 TTL 8시간은 세션이 `ACTIVE`가 된 시점부터 계산하고 reset하지 않는다. 열린 앱 Stream이 하나라도 있으면 Session idle로 보지 않으며, Stream이 없을 때 마지막 앱 Stream 종료 시각부터 30분의 유휴 시간을 계산한다. heartbeat와 인증·제어 요청은 Session idle을 갱신하지 않는다.
- Carrier가 끊기면 2분의 재연결 유예를 시작한다. 같은 Gateway의 Registry entry가 남은 상태에서 이 시간 안에 activation을 완료한 새 generation만 동일 URL을 복구할 수 있다.
- Client가 실행 중이어도 최대 TTL, 유휴 만료 또는 재연결 유예 만료에 도달하면 `EXPIRED`가 된다. Client는 이유를 출력하고 종료하며 새 URL을 자동 발급하지 않는다.
- 자동 재시도는 일시적인 네트워크 오류와 `RESUME_IN_PROGRESS` 경합에만 제한한다. 경합 응답은 bounded `Retry-After`를 포함하고 Client는 재연결 유예·activation timeout 안에서만 새 Carrier credential을 발급받아 backoff와 jitter로 다시 시도한다. 인증, 대상 검증 또는 프로토콜 버전 오류는 우회하거나 무한 재시도하지 않고 종료한다.
- current generation에 활성 binding이 확정된 Carrier의 `PROTOCOL_ERROR`·`FLOW_CONTROL_ERROR`는 Session을 `CLOSED`로 만드는 fatal 오류다. 후보 Carrier가 current generation에 바인딩되기 전의 version·resume·인증·설정 오류는 그 시도만 거부하고 기존 Session을 닫지 않는다. 개발자·Tunnel 회수는 별도의 Control Plane terminal 이벤트로 처리한다. 오류 frame 없이 발생한 일시적인 transport 단절만 `RECONNECTING` 대상이다.
- 재연결은 새 generation의 `SESSION_CONFIG` 적용 확인과 Relay probe를 다시 통과해야 `ACTIVE`가 된다. 이전 generation에서 true였던 `carrier_alive`, `config_applied`, `relay_probe_ok`를 새 Carrier에 승계하지 않는다.

#### 활성화 전 실패 결과

| 시도 | 실패 시 Session 결과 |
| --- | --- |
| create, provisional Session 생성 전 | Carrier 시도만 거부하고 Session·URL을 만들지 않음 |
| create, provisional Session 생성 뒤 `SESSION_ACTIVE` 전 | provisional route와 Resume secret을 폐기하고 Session을 `CLOSED` 처리한 뒤 제거. URL은 한 번도 라우팅하지 않음 |
| resume, candidate generation 바인딩 전 | candidate generation과 Carrier만 폐기하고 기존 Session은 재연결 유예 동안 `RECONNECTING` 유지. 새 Carrier credential로 다시 시도 가능 |
| current generation 활성 binding 뒤 fatal protocol·flow-control 오류 | 해당 Session을 `CLOSED` 처리하고 모든 Stream·Carrier·Resume secret 폐기 |
| 개발자·Tunnel 회수 또는 최대 TTL | candidate 여부와 무관하게 Control Plane이 scope 전체를 terminal 처리 |

잘못된 Resume secret, stale generation과 미바인딩 후보의 version 오류는 rate limit과 보안 이벤트 대상이지만 기존 Session의 상태를 바꾸는 입력으로 사용하지 않는다.

## 9. 중계 프로토콜과 프록시 정책

### 9.1 중계 전송 요구사항

Client–Gateway 중계 연결은 세션당 하나의 TLS 기반 WebSocket을 사용하고 subprotocol `review-tunnel.v1`을 검증한다. v1은 HTTP streaming, WebSocket upgrade와 flow control을 하나의 고정 profile로 정의한다. 한쪽이라도 v1 전체를 지원하지 않으면 세션 생성을 실패시키며 수동 새로고침 전용 모드로 조용히 낮추지 않는다.

하나의 Carrier WebSocket 안에서 여러 논리 Stream을 multiplexing한다.

    Carrier WebSocket
    ├── stream 0: session control
    ├── stream 1: HTML HTTP
    ├── stream 2: image HTTP
    ├── stream 3: SSE
    ├── stream 4: HMR WebSocket
    └── stream 5: API request

Gateway는 connection generation 안에서 재사용하지 않는 단조 증가 Stream ID를 만들고, 외부 추적용 Request ID는 별도로 발급한다. WebSocket이 같은 generation의 순서와 무결성을 보장하므로 MVP는 별도 chunk ACK, checksum 또는 replay protocol을 만들지 않는다.

#### 최소 메시지

| 메시지 | 방향 | 역할 |
| --- | --- | --- |
| `HELLO` | Client → Gateway | create/resume mode, canonical local-origin fingerprint, 요청 Origin projection, Client instance와 protocol version 제시. resume이면 Session·Resume secret도 포함 |
| `SESSION_PROVISIONED` | Gateway → Client | create 전용 provisional Session·Tunnel·공유 URL, provision ID와 Resume secret을 config digest 밖의 activation material로 한 번 전달. 아직 라우팅 불가 |
| `SESSION_CONFIG` | Gateway → Client | candidate generation에 적용할 불변 snapshot, desired revision·digest, profile·제한과 초기 connection window 전달 |
| `CONFIG_APPLIED` | Client → Gateway | candidate generation의 revision·digest 적용 결과와 초기 origin 점검 결과 전달. create이면 `SESSION_PROVISIONED`의 provision receipt 포함 |
| `OPEN_PROBE` | Gateway → Client | candidate generation에서 양방향 초기 Stream window와 함께 reserved probe를 시작해 같은 framing·scheduler·flow-control 경로의 data readiness 확인 |
| `SESSION_ACTIVE` | Gateway → Client | candidate를 current로 승격한 activation commit 통지, Registry route·lease·공유 URL 확정 |
| `PING` / `PONG` | 양방향 | Stream 0에서 Carrier 상태와 lease 확인 |
| `CLOSE_SESSION` | Client → Gateway | 명시적 세션 종료 요청 |
| `SESSION_CLOSED` | Gateway → Client | Session을 라우팅 불가능하게 만든 뒤 보내는 종료 확인 |
| `OPEN_HTTP` | Gateway → Client | `SESSION_ACTIVE` 뒤 HTTP 요청 또는 WebSocket handshake 시작 |
| `RESPONSE_HEADERS` | Client → Gateway | 로컬 HTTP 응답 시작 |
| `DATA` | 양방향 | HTTP body, 101 upgrade 이후 opaque bytes 또는 reserved probe bytes |
| `END_STREAM` | 양방향 | 해당 송신 방향에 더 보낼 byte가 없음을 알리는 half-close |
| `WINDOW_UPDATE` | 양방향 | 실제 소비한 byte만큼 송신 가능량 반환 |
| `RESET_STREAM` | 양방향 | 취소 또는 Stream 단위 오류 |
| `CONNECTION_ERROR` | 양방향 | Carrier 전체를 닫아야 하는 protocol 오류 |

인증형 Gateway에서 개발자 신원은 WSS 연결의 인증 context에서만 가져온다. `HELLO` payload에 별도 신원 값이 있더라도 인가 근거로 사용하지 않는다. v1 heartbeat는 Stream 0의 `PING`·`PONG`만 사용한다. candidate generation heartbeat는 activation liveness만, current generation heartbeat는 Carrier lease만 갱신하며 어느 쪽도 Session의 앱 유휴 시간을 갱신하지 않는다.

Carrier credential만 WSS HTTP upgrade의 `Authorization: Bearer`에서 Carrier 인증에 사용한다. 개발자 access·refresh token과 검토자 세션 값은 Carrier endpoint에서 받지 않는다. URL path·query·fragment, Cookie, `Sec-WebSocket-Protocol` 또는 `HELLO`에 실린 값을 Carrier 인증에 사용하지 않으며 `Sec-WebSocket-Protocol`은 `review-tunnel.v1` profile 식별에만 사용한다. Resume secret은 Carrier 인증이 끝난 WSS 안에서 `HELLO`의 resume 필드로만 받고 현재 개발자 신원·Session 복구 검증에 사용한다.

create의 `SESSION_PROVISIONED`는 config snapshot과 분리한다. Gateway는 Resume secret HMAC만 provisional Session 상태에 저장하고 원문은 receipt timeout이 있는 bounded transient buffer에만 둔다. Client는 secret을 프로세스 메모리에 보관하고 `provision_id`를 `CONFIG_APPLIED`에 되돌려 수신을 확인한다. receipt 누락·불일치·timeout이면 provisional Session, HMAC과 원문 buffer를 모두 폐기하고 URL을 활성화하지 않는다. 이 확인 덕분에 commit 뒤 `SESSION_ACTIVE` frame이나 Carrier가 유실돼도 Client는 이미 가진 Session ID·공유 URL·Resume secret으로 같은 URL의 resume을 시도할 수 있다.

`SESSION_CONFIG`는 canonical encoding한 snapshot의 SHA-256 digest와 Session 안에서 단조 증가하는 revision을 포함한다. snapshot은 candidate generation 동안 불변이며 resume으로 candidate generation이 바뀌면 새 revision을 발급한다. Client는 candidate generation·revision·digest를 모두 확인한 전체 snapshot만 적용하며, `CONFIG_APPLIED`의 세 값과 create의 provision receipt가 desired 값과 정확히 일치하기 전에는 candidate를 current로 승격하거나 `OPEN_HTTP`를 보낼 수 없다. 정확히 같은 성공 ACK의 중복은 idempotent no-op으로 처리하고, ACK timeout에는 동일 snapshot을 한 번만 재전송할 수 있다. 현재 candidate가 아닌 generation은 stale로 candidate Carrier를 즉시 거부하며 digest mismatch와 명시적 적용 실패는 재전송하지 않고 fail-closed한다. 새 snapshot은 새 revision에서만 발급하고 delta patch나 이전 generation의 적용 결과를 재사용하지 않는다.

`OPEN_PROBE`는 current 승격 전 candidate generation에만 유효한 reserved `PROBE` kind와 양방향 초기 Stream window를 가진다. Gateway가 작은 무작위 nonce를 `DATA`·`END_STREAM`으로 보내면 Client가 같은 Relay Core, bounded queue, scheduler와 flow-control 경로로 byte를 돌려보내고 양쪽이 종료된다. probe는 로컬 앱 요청을 만들거나 application Stream으로 노출되지 않으며, 별도 local origin probe와 함께 성공해야 한다. probe payload 자체는 로그·trace에 남기지 않고 digest 일치 여부와 지연만 기록한다.

`SESSION_ACTIVE` 전에는 `OPEN_PROBE` 외의 새 Stream을 금지한다. probe Stream도 일반 Stream ID·generation fencing·window·terminal 불변식을 따르되 HTTP headers나 WebSocket upgrade 상태는 갖지 않는다.

`OPEN_HTTP`에는 Stream ID, Request ID, `HTTP` 또는 `WEBSOCKET` kind, method, path와 query, 순서가 보존된 header 목록, 요청 body 종료 여부와 양방향 초기 Stream window를 담는다. `RESPONSE_HEADERS`에는 최종 status, 순서가 보존된 header 목록과 응답 종료 여부를 담는다. head와 함께 끝나지 않는 방향은 마지막 `DATA` 뒤에 `END_STREAM`을 보낸다. 반복 header와 여러 `Set-Cookie`를 잃지 않도록 header를 단순 map으로 표현하지 않는다.

101 전에는 Gateway가 보낸 `DATA`가 request body이고 Client가 보낸 `DATA`가 response body다. 101 후에는 양방향 모두 upgraded raw bytes다. `END_STREAM`은 전체 Stream이 아니라 메시지를 보낸 endpoint의 해당 송신 방향만 half-close한다. 정상 완료는 두 방향이 모두 끝났을 때 성립한다.

`DATA` payload는 항상 binary-safe raw bytes이고 JSON metadata와 분리한다. v1 envelope는 16-byte header와 최대 65,535-byte payload를 사용하며 `DATA`는 최대 32 KiB chunk로 자른다. 알 수 없는 frame type·flag·version은 fail-closed한다. 계약을 바꿀 때는 같은 v1의 의미를 조용히 바꾸지 않고 새 version으로 올린다. 본문 전체를 JSON 문자열 하나에 담거나 base64로 누적하지 않는다.

#### Stream 상태와 불변식

하나의 application Stream은 다음 상태를 독립적으로 관리한다.

- phase: `HTTP_HANDSHAKE`, `HTTP_BODY`, `UPGRADED_RAW` 또는 `TERMINAL`
- HTTP request side: `OPEN` 또는 `ENDED`
- HTTP response side: `WAITING_HEADERS`, `OPEN` 또는 `ENDED`
- upgraded raw client→local side: `OPEN` 또는 `ENDED`
- upgraded raw local→client side: `OPEN` 또는 `ENDED`
- terminal: `NONE`, `COMPLETED` 또는 `RESET(error_code)`

일반 HTTP와 SSE는 `RESPONSE_HEADERS → DATA* → END_STREAM` 흐름을 사용한다. WebSocket handshake는 request body 없는 HTTP 요청으로 시작한다. 로컬의 유효한 101을 받으면 HTTP body 방향을 raw 방향과 분리해 같은 Stream의 phase를 `UPGRADED_RAW`로 바꾸고, client→local과 local→client raw 방향을 새로 `OPEN`으로 초기화한다.

reserved probe Stream은 `OPEN_PROBE → DATA* → END_STREAM` 양방향과 terminal 상태만 가지며 HTTP headers·method·status 또는 upgrade 상태를 갖지 않는다. 일반 application Stream과 같은 Stream ID, generation fencing, window, queue와 terminal race 규칙을 적용하되 외부 Request ID나 로컬 socket을 만들지 않는다.

필수 불변식:

- `RESPONSE_HEADERS`는 Stream당 한 번만 허용한다.
- request와 response 방향은 독립적으로 half-close할 수 있다.
- 정상 완료와 `RESET_STREAM` 중 하나만 terminal 결과가 된다.
- 해당 방향의 `END_STREAM` 뒤에 온 DATA와 terminal 이후 늦게 도착한 DATA는 폐기하고 계수한다.
- 응답이 먼저 끝나 더 이상 request body가 필요 없으면 upstream read를 취소한다.
- terminal인 알려진 Stream에서 교차 도착한 DATA·RESET은 폐기하고 계수한다. 한 번도 열리지 않은 Stream ID, 같은 generation 안의 ID 재사용과 허용되지 않은 방향의 메시지는 connection-level protocol 오류다.
- terminal tombstone은 늦은 메시지를 판별할 수 있도록 generation 안에서 byte·개수 상한을 두고 보관한다.
- protocol state 위반은 순수 상태 전이 함수로 검증한다.

WSS가 성립한 뒤 `HELLO`부터 `SESSION_ACTIVE` 전까지 발생한 resume·profile·provision receipt·설정 적용·probe·protocol 실패는 `CONNECTION_ERROR`의 안정적인 code로 알린 뒤 candidate Carrier를 닫고, Session 결과는 8.4절의 create/resume 실패 정책을 따른다. WSS 인증·subprotocol 검증 실패는 Carrier가 없으므로 HTTP upgrade 단계에서 거부한다. 최소 connection code는 `VERSION_UNSUPPORTED`, `AUTH_FAILED`, `RESUME_REJECTED`, `RESUME_IN_PROGRESS`, `SESSION_NOT_FOUND`, `PROVISION_RECEIPT_FAILED`, `CONFIG_APPLY_FAILED`, `CONFIG_ACK_TIMEOUT`, `LOCAL_ORIGIN_UNAVAILABLE`, `RELAY_NOT_READY`, `ACTIVATION_TIMEOUT`, `PROTOCOL_ERROR`, `FLOW_CONTROL_ERROR`다. `RESUME_IN_PROGRESS`만 bounded `retry_after_ms`를 가질 수 있으며 다른 fatal code에는 자동 fallback 정보를 넣지 않는다. `RESET_STREAM`의 최소 code는 `CANCELLED`, `LOCAL_CONNECT_FAILED`, `LOCAL_IO_ERROR`, `HEADER_TIMEOUT`, `IDLE_TIMEOUT`, `LIMIT_EXCEEDED`, `SESSION_CLOSED`, `INTERNAL_ERROR`다. 자유 형식 로컬 오류 문자열은 브라우저 응답이나 공용 로그에 사용하지 않는다.

#### Flow control과 공정성

- Stream별·방향별 byte window와 connection 전체·방향별 aggregate window를 둔다. 초기 connection window는 `SESSION_CONFIG`, 양방향 초기 Stream window는 application Stream의 `OPEN_HTTP`와 probe Stream의 `OPEN_PROBE`에서 각각 확정한다.
- 송신자는 두 window에 남은 credit만큼만 DATA를 보낸다.
- `WINDOW_UPDATE`는 방향별 credit이다. 수신자가 보낸 update는 상대가 자신에게 보내는 방향의 credit만 늘린다.
- 수신자는 DATA가 bounded application queue를 떠나 downstream write에 성공적으로 인계된 byte만큼 credit을 반환한다. downstream이 backpressure를 표시하면 writable 상태가 회복될 때까지 추가 credit을 반환하지 않는다.
- window가 0이면 해당 Stream만 멈추고 control message와 다른 Stream은 계속 처리한다.
- `RESET_STREAM`, `WINDOW_UPDATE`, heartbeat 같은 control message는 DATA window를 소비하지 않으며 일반 DATA보다 우선한다.
- DATA chunk 크기와 모든 queue의 byte 상한을 설정하고 socket pending-write byte도 메모리 상한에 포함한다.
- writer는 활성 Stream을 공정하게 순회해 큰 다운로드가 HMR이나 heartbeat를 독점하지 않게 한다.
- flow-control 위반은 임의 buffering으로 숨기지 않고 protocol 오류로 연결을 종료한다.

`WINDOW_UPDATE`는 재전송 ACK가 아니다. Carrier가 끊기면 열린 Stream의 처리 중 데이터는 폐기하며 새 generation에서 이어 붙이거나 replay하지 않는다.

### 9.2 투명성 예외와 header·URL 정책

다음 항목은 의미 보존을 위한 프록시 변환 또는 Gateway 보안 경계이며, 그 밖의 앱 정책은 Tunnel이 판단하지 않는다.

- 일반 HTTP의 `Connection`에 열거된 header와 `Keep-Alive`, `Transfer-Encoding` 등 hop-by-hop header는 각 프록시 구간에서 동적으로 제거·재구성한다. HTTP 전송 framing만 구간별로 다시 만들고 앱의 `Content-Encoding`을 유지한 representation body bytes는 streaming한다.
- `/_review-tunnel/*` 같은 Gateway 예약 경로는 로컬 앱으로 전달하지 않는다.
- 검토자 인증 쿠키, Gateway 내부 토큰과 예약 header는 로컬 앱으로 전달하지 않는다. 앱 자체의 `Authorization`과 method-override header는 Gateway 자격 증명과 분리해 그대로 전달한다.
- 외부에서 전달된 `Forwarded`와 `X-Forwarded-*` 값은 신뢰하지 않고 Gateway 경계에서 제거한다.
- HTTP method의 이름이나 부작용을 기준으로 allowlist를 두지 않는다. 표준 parser가 수용한 application request를 전달하되 generic proxy CONNECT와 `websocket` 이외의 임의 Upgrade는 지원하지 않는다.
- 상충하는 `Content-Length`·`Transfer-Encoding` 등 모호하거나 비정상적인 요청은 표준 HTTP 파서 단계에서 거부한다.
- 기본 `local-view` projection은 `Host`를 로컬 origin으로 설정하고, 현재 공유 origin과 같은 `Origin`·`Referer`만 로컬 origin으로 바꾸며 `Forwarded`·`X-Forwarded-*`를 추가하지 않는다. Host와 Origin을 일관되게 유지해 일반 개발 서버의 same-origin 검사를 통과시킨다.
- opt-in `proxy-aware` projection은 `Host`, same-origin `Origin`·`Referer`와 Gateway가 생성한 `Forwarded`·`X-Forwarded-*`를 모두 공개 origin 기준으로 일관되게 설정한다. 공개 host를 신뢰하도록 명시적으로 구성한 앱에서만 사용한다.
- 로컬 앱의 `Set-Cookie`는 comma-fold하지 않고 각각 보존한다. Domain이 없으면 그대로 전달하고, Domain이 현재 projection의 effective host(`local-view`의 로컬 host 또는 `proxy-aware`의 정확한 Tunnel host)와 일치할 때만 Domain을 제거해 Tunnel host-only cookie로 만든다. parent·shared Domain, 그 밖의 Domain 또는 `__Host-rt_*` 예약 이름은 해당 `Set-Cookie`를 폐기하고 이벤트를 남긴다.
- 앱 Cookie의 Path, Secure, HttpOnly, SameSite, Max-Age, Expires와 Partitioned 속성은 보존한다. 요청에서는 Gateway 예약 cookie만 제거하고 앱 cookie는 전달한다.
- `Location` 또는 `Refresh`의 origin이 세션에 고정된 로컬 origin과 정확히 같을 때만 공유 origin으로 바꾼다. 상대 URL과 다른 외부 origin은 그대로 둔다.
- WebSocket handshake에서는 `Connection`·`Upgrade`를 양쪽 구간에 맞게 재구성하고 `Sec-WebSocket-Key`, version, subprotocol과 extension 제안을 로컬 서버까지 보존한다. 로컬 `Sec-WebSocket-Accept`와 선택된 subprotocol·extension을 검증한 후 전달한다.
- 브라우저 request parser가 HTTP header 뒤에서 이미 읽은 upgraded head bytes는 유효한 로컬 101이 확인될 때까지 작은 bounded pending-upgrade buffer에 둔다. `UPGRADED_RAW` 전이 후 client→local 방향의 첫 raw `DATA`로 보내며, 상한 초과 또는 non-101 응답이면 연결을 protocol 오류로 종료한다. 로컬 response parser의 head bytes는 `RESPONSE_HEADERS(101)` 직후 local→client 방향의 첫 raw `DATA`로 보낸다. 어느 방향에서도 handshake와 함께 읽힌 upgraded bytes를 폐기하지 않으며 101 이후에는 inner WebSocket bytes를 parsing, decompress 또는 재구성하지 않는다.
- Carrier WSS의 per-message compression은 inner stream의 latency와 CPU 사용을 예측 가능하게 하기 위해 MVP 기본값에서 끈다.
- SSE와 그 밖의 streaming 응답은 Ingress·Gateway·Client 전 구간에서 response buffering과 임의 compression을 끄고 도착한 chunk를 즉시 flush한다.
- 앱의 `Content-Encoding`은 임의로 해제하거나 바꾸지 않으며 raw path·query의 의미를 보존한다.
- query string과 본문은 중계하되 로그에는 기록하지 않는다.
- 콘텐츠 host의 Ingress·Gateway shared cache는 항상 bypass한다. 앱의 cache header는 브라우저까지 전달하되 중앙 인프라가 인증된 응답을 사용자 사이에 재사용하지 않는다.

Origin projection은 세션 생성 시 하나를 고정하고 HTTP와 WebSocket 모두에 같은 정책을 적용한다. 프레임워크별 Host·Origin 검사나 공개 HMR 주소 설정이 다를 수 있으므로 generic projection으로 해결하지 못하는 경우에만 명시적 호환 설정을 제공한다. 핵심 중계 흐름에 프레임워크 이름별 조건문을 누적하지 않으며 HTML·JavaScript 안에 hard-coded된 `localhost` URL은 자동 치환하지 않는다.

Host와 Origin 계열을 섞지 않는 이유는 일부 개발 서버가 두 값을 보안 검증에 함께 사용하기 때문이다. 예를 들어 Next.js Server Actions는 요청의 Origin과 Host를 비교한다. 자세한 동작은 [Next.js Server Actions 공식 문서](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions)를 기준으로 호환성 테스트에서 확인한다.

### 9.3 운영 제한

다음 값은 환경 설정으로 노출한다. 제품 정책으로 승인된 Session 값은 고정하고 나머지 전송·자원 제한은 POC 측정 뒤 파일럿 전에 확정한다.

- Session: 최대 TTL 8시간, 활성 Stream이 없을 때 유휴 만료 30분, 재연결 유예 2분, Client의 기본 종료 확인 timeout 1초
- Carrier: handshake timeout, heartbeat 주기·timeout, connection window, aggregate queue와 control message 크기·rate 상한
- local origin: connect timeout과 response-header timeout
- HTTP request: 총 크기와 body inactivity timeout
- `http-finite` response: 총 크기와 body inactivity timeout
- streaming/SSE: first-byte timeout, chunk inactivity timeout, write-stall timeout, 최대 지속 시간과 Stream별 buffer 상한
- WebSocket: upgrade handshake timeout, byte inactivity timeout, write-stall timeout, 최대 지속 시간과 Stream별 buffer 상한
- Tunnel별 finite HTTP·streaming·WebSocket 동시 Stream 수
- DATA chunk 최대 크기, Stream·connection flow-control window와 전송률
- 사용자별 활성 Tunnel 수와 Gateway 전체 동시 Tunnel·Stream·전송량
- 인증·세션 생성·새 Stream 생성 rate limit

HTTP response의 제한 class는 `RESPONSE_HEADERS` 뒤에 다음 순서로 정한다. 101은 `websocket`, `Content-Type: text/event-stream`은 길이와 무관하게 `http-stream`, body가 없거나 신뢰 가능한 총 길이가 알려진 그 밖의 응답은 `http-finite`, 나머지 총 길이 미상 응답은 `http-stream` 정책을 적용한다. 총 길이를 알 수 없는 finite 응답도 전송 중에는 안전을 위해 stream 정책을 적용하고 `END_STREAM`에서 관찰 유형만 finite로 확정한다. 이 분류는 제한과 로그에만 쓰며 Relay wire 흐름은 모두 같은 `DATA`·`END_STREAM`을 사용한다.

finite HTTP에만 누적 response 크기 제한을 적용한다. 종료 시점이 없는 SSE·WebSocket은 누적 byte로 자르지 않고 buffer, 전송률, inactivity, 최대 지속 시간과 동시 Stream 수로 제한한다. 제한을 초과하면 자동으로 다른 방식으로 우회하지 않고 명시적인 오류와 운영 이벤트를 남긴다.

## 10. 인증, 인가와 보안

### 10.1 두 인증 경계

검토자 인증과 Client 인증은 목적과 자격 증명이 다르므로 분리한다.

- 검토자 인증: 공유 URL의 앱 응답을 볼 수 있는지 판단한다.
- Client 인증: 누가 인증형 Gateway에 로컬 원본을 등록할 수 있는지 판단한다.

두 경계는 같은 계정 저장소를 사용하되 요구 권한과 세션 audience를 분리한다. `REVIEWER` 세션으로 WSS Session을 등록하거나 `DEVELOPER` 전용 자격증명으로 관리자 기능을 사용할 수 없다. 재연결도 현재 유효한 개발자 계정과 Resume secret을 함께 검증한다.

공개 회원가입은 없으며 최초 `ADMIN`만 서버 CLI에서 원자적으로 1회 생성한다. 관리자는 이후 UI 또는 인증된 CLI에서 계정을 생성한다. 임시 비밀번호는 발급 응답에 한 번만 표시하고 최초 로그인 후 새 비밀번호로 변경하기 전에는 공유·관리 작업을 허용하지 않는다.

HTTP request와 WebSocket handshake를 열 때 검토자 신원, 인증 만료와 Tunnel Session을 논리 Stream에 바인딩한다. 인증 max-age, Session 종료·만료, 감지된 token 회수 이벤트 또는 운영 kill switch가 발생하면 scope에 속하는 진행 중 finite HTTP, streaming/SSE와 WebSocket도 설정된 전파 SLO 안에 종료한다. upgrade 이후 장기 연결을 인증 기한 없이 방치하지 않는다.

### 10.2 Client 자격증명 수명주기

개발자 로그인 자격증명을 Carrier WSS에 직접 반복 전송하지 않는다. 인증된 로그인 context는 control API에서 `create` 또는 `resume` 목적의 짧은 수명·1회용 opaque Carrier credential을 발급받을 때만 사용한다. credential은 public ID와 CSPRNG secret으로 구성하고 개발자 신원, control host audience, purpose, 발급·만료 시각과 미사용 상태에 바인딩한다.

| 자격증명 | 용도 | Client·브라우저 저장 | Gateway 저장 | 만료·회수 |
| --- | --- | --- | --- | --- |
| 개발자 로그인 자격증명 | Carrier credential 발급 | 필요하면 OS 보안 저장소 | Argon2id password hash와 opaque 세션 HMAC | 계정·비밀번호·권한 변경 또는 12시간 만료 때 회수 |
| Carrier credential | WSS create 또는 resume 1회 인증 | 연결 직전 프로세스 메모리만 사용 | public ID, 용도별 HMAC, purpose·audience·expiry·consumed 상태 | 짧은 TTL, Registry의 소비 CAS와 `UNBOUND_CARRIER` 할당 뒤에는 101 전달 실패도 소비로 유지 |
| Resume secret | 동일 Session의 새 generation 복구 | Client 프로세스 메모리 | Session·개발자에 바인딩된 용도별 HMAC lookup 값 | Session terminal 전이와 함께 폐기 |
| 검토자 host 세션 | 하나의 Tunnel host 접근 | `__Host-rt_session` Secure·HttpOnly cookie | host·Tunnel·검토자·expiry에 바인딩된 HMAC session ID | Tunnel TTL, 인증 max-age, 접근 회수 중 먼저 도달한 때 |
| host 교환 코드 | 중앙 로그인에서 Tunnel host 세션으로 교환 | 브라우저 redirect 동안만 전달 | host·검토자에 바인딩된 HMAC과 consumed 상태 | 매우 짧은 TTL과 1회 소비 |

Gateway는 Carrier credential secret, Resume secret과 opaque 검토자 세션 ID의 원문을 Registry·DB·cache 같은 상태 저장소에 남기지 않는다. 용도별 서버 키와 versioned length-prefix canonical bytes를 사용해 HMAC-SHA-256 lookup 값을 만들고 constant-time으로 비교한다. 원문은 발급·검증 중 bounded transient buffer에만 존재하고 처리 직후 참조를 해제하며 로그·trace·crash dump 수집 대상에서 제외한다. HMAC key는 소스나 일반 설정 파일이 아니라 배포 환경의 secret manager에서 관리한다. 새 artifact는 active key로 발급하고 이전 key 목록은 로그인 세션 최대 12시간과 시계 오차를 포함한 제한된 overlap 동안 검증에만 사용한 뒤 제거한다.

Client는 Carrier credential과 Resume secret을 stdout, shell history, debug log, crash report나 telemetry에 출력하지 않는다. 개발자 로그인 자격증명은 필요할 때만 OS 보안 저장소에 두고 Carrier credential과 Resume secret은 기본적으로 디스크에 기록하지 않는다. 진단 bundle은 Authorization·Cookie header 전체와 URL query를 구조적으로 제거한 뒤 생성한다.

Carrier credential은 WSS `Authorization` header 외 위치에서 받지 않으며 성공한 연결 이후의 Session 인증 수명과는 구분한다. credential TTL이 연결 뒤 만료됐다는 이유만으로 정상 Carrier를 자동 종료하지는 않지만, 현재 개발자 권한은 설정된 developer authorization max-age마다 저장소 재검증으로 다시 확인한다. 회수 신호가 없는 환경에서는 이 max-age가 최악의 감지 지연 상한이며 Session 최대 TTL보다 길 수 없다. 개발자·Tunnel 회수, Session 최대 TTL과 인증 max-age는 현재 Carrier와 열린 Stream에 적용하고 재시도와 resume에는 항상 새 Carrier credential이 필요하다.

재사용 가능한 로그인 세션, Carrier credential, Resume secret과 검토자 세션 값은 Gateway 인증 목적으로 URL path·query·fragment나 `Sec-WebSocket-Protocol`에 넣지 않는다. 앱의 `Authorization`과 query는 콘텐츠 중계 데이터일 뿐 Gateway 인증에 사용하지 않는다. 예외는 Gateway가 발급한 짧은 수명·1회용 host 교환 코드뿐이다. 원래 Tunnel host·path·application query는 짧은 수명 서버 측 record에 보관하며, 교환 뒤 code를 제거한 원래 application URL로 `303` 이동시킨다.

### 10.3 검토자 계정 세션 흐름

와일드카드 Tunnel host 전체에 공유되는 Domain cookie는 사용하지 않는다.

1. 인증되지 않은 검토자가 Tunnel host를 열면 Gateway가 대상 Tunnel host, 원래 path·application query와 만료를 서버 측 one-time record에 저장하고 브라우저에는 추측하기 어려운 opaque state handle만 전달한다.
2. 콘텐츠 wildcard 바깥의 control host가 opaque state를 받아 Gateway 소유 로그인 화면을 표시한다.
3. Gateway가 관리자 발급 계정의 비밀번호와 로그인 제한을 검증하고 control host 전용 세션을 발급한다.
4. Gateway가 대상 host, 검토자 신원과 짧은 만료 시간에 바인딩된 일회용 교환 코드를 발급한다.
5. 브라우저가 대상 Tunnel host의 `/_review-tunnel/session` 예약 경로로 돌아온다.
6. Gateway가 코드를 한 번만 소비하고 `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` 조건을 가진 `__Host-rt_session` host-only 쿠키를 발급한다.
7. Gateway가 교환용 parameter만 제거한 원래 path와 application query로 이동시키고 이후 요청마다 접근 정책을 다시 확인한다.

Gateway의 중앙 인증 세션은 control host 전용 `__Host-*` host-only 쿠키만 사용하고 콘텐츠 host로 보내지 않는다. 모든 control 상태 변경은 정확한 control `Origin`을 요구한다. 콘텐츠 host에는 해당 Tunnel 접근에만 사용하는 `__Host-rt_session` host-only 쿠키만 둔다. state는 무작위 handle이고 원래 host·path·application query는 Gateway의 짧은 수명 record에서 허용된 공유 host만 대상으로 검증해 open redirect를 막는다. 일회용 코드 교환 응답에는 `Cache-Control: no-store`와 `Referrer-Policy: no-referrer`를 적용하고 query를 로그에서 제외한다. 애플리케이션이 반환한 `Set-Cookie`는 Gateway의 예약 쿠키를 만들거나 덮어쓸 수 없다.

와일드카드 아래의 콘텐츠 host들은 민감한 보안 경계로 간주하지 않는다. Tunnel 간 앱 쿠키 격리가 필요한 프로젝트는 콘텐츠 도메인의 Public Suffix 정책 또는 별도 격리 방식을 확정하기 전까지 파일럿 대상에서 제외한다.

### 10.4 위협과 기본 통제

| 위협 | 기본 통제 |
| --- | --- |
| 인증형 Gateway URL을 획득한 사용자 | 관리자 발급 계정 인증과 `REVIEWER` 권한을 요청 전달 전에 적용 |
| Tunnel ID 추측 | 충분한 엔트로피의 ID 사용. ID와 무관하게 매 요청 인가 수행 |
| 비인가 Client 등록 | 개발자 인증, 짧은 수명의 연결 자격 증명, 회수 가능한 토큰 |
| Carrier credential 탈취·재사용 | 짧은 TTL·1회 소비·purpose·audience 바인딩, Authorization header 전용 전달과 상태 저장소 원문 비저장 |
| 설정 전송과 실제 적용 불일치 | candidate generation의 revision·digest ACK와 Relay probe 전에는 current 승격·`ACTIVE` 전이 금지 |
| Control 연결은 성공했으나 Data 경로 실패 | 구성 요소별 Readiness를 분리하고 local origin·Relay probe 실패를 명시적으로 노출 |
| 내부망 대상 프록시 | 기본 대상을 루프백으로 제한하고 입력 정규화 후 검증 |
| 상위 도메인의 기존 Cookie가 공유 콘텐츠로 전달됨 | 다른 서비스와 기준 도메인을 공유할 때 `Domain` Cookie 범위를 검토하고, Gateway 자체 control·content 인증에는 host-only Cookie를 사용하며 control mutation의 정확한 Origin을 확인 |
| 신뢰된 링크처럼 보이는 피싱 | 로그인·오류 화면에 임시 개발 미리보기와 소유 개발자 표시 |
| Gateway 인증 정보 유출 | Tunnel host 전용 Secure·HttpOnly·SameSite 쿠키 사용, 로컬 전달 및 로그 기록 차단 |
| 요청·응답 내용 유출 | 전 구간 TLS, 본문 비저장, 민감 헤더와 query 로그 제외 |
| 미인증 장기 연결 | WebSocket upgrade 전에 인증·인가하고 Stream을 인증 만료와 Session 수명에 바인딩 |
| 자원 고갈 | 요청 크기, timeout, 동시성, 세션 수와 rate limit 적용 |
| Resume secret 재사용 | 세션과 개발자 신원에 바인딩하고 만료·종료 시 폐기 |
| 계정 저장소 장애 또는 자격 증명 회수 | 인증 우회 없이 fail-closed하고 관리자 회수 뒤 scope별 전파 SLO 안에 접근 context·Stream·Carrier를 폐기하는 운영 kill switch 제공 |
| Ingress 설정·버전 drift | 고정 wildcard route, 버전·config digest pinning, 실제 public-path canary와 rollback |
| 오류를 통한 내부 정보 노출 | 외부 오류에는 로컬 주소, 스택, 토큰과 세션 내부 정보 제외 |

### 10.5 회수 의미와 전파

회수는 새 요청만 막는 동작이 아니다. Gateway가 회수 이벤트를 받으면 먼저 회수 scope를 확정하고 그 scope에 속하는 접근 context, Tunnel route 또는 Carrier binding만 라우팅 불가능하게 표시한다. 이어 scope에 속하는 미사용 Carrier credential·검토자 세션·Resume secret을 무효화해 새 Stream과 resume을 원자적으로 거부한 뒤, 진행 중 finite HTTP, streaming/SSE와 WebSocket을 cancel·close하고 필요한 Carrier를 종료한다. terminal 상태와 generation fencing 때문에 늦은 frame이나 과거 credential이 Session을 다시 활성화할 수 없어야 한다.

검토자 계정·Tunnel 접근 회수는 그 검토자의 세션과 진행 중 finite HTTP·streaming/SSE·WebSocket에만 적용하고 다른 검토자, Tunnel route, Carrier와 Resume secret은 유지한다. 개발자·Tunnel 회수와 운영 kill switch는 해당 Tunnel route, 모든 Stream·Carrier·미사용 Carrier credential과 Resume secret에 적용한다. "즉시"는 관리 명령이 PostgreSQL에 반영되고 Gateway가 이를 관찰한 시점부터 설정된 revocation propagation SLO 안에 적용한다는 뜻이다. 매 요청·새 Stream에서 계정 `auth_version`과 활성 상태를 확인하고, 장기 Stream은 주기적으로 재검증한다. 저장소 불확실성을 cached allow 또는 익명 접근으로 fallback하지 않는다.

### 10.6 데이터 처리 원칙

- Gateway는 중계와 bounded flow-control에 필요한 동안만 요청·응답 chunk와 opaque upgraded bytes를 메모리에 보유한다.
- 애플리케이션 본문과 파일을 영구 저장하지 않는다.
- Cookie, Authorization, 비밀번호, 임시 비밀번호와 Resume secret을 평문 로그에 남기지 않는다.
- Carrier credential, Resume secret과 검토자 세션 원문은 Registry·DB·cache에 저장하지 않고 용도별 HMAC lookup 값만 저장한다. 발급·검증 중의 원문은 bounded transient buffer에서 처리 직후 해제하고 로그·trace·crash dump에서 제외한다.
- 운영 로그의 보존 기간과 접근 권한은 배포 환경의 운영 정책에 맞춰 확정한다.
- 개발자 로그인 자격증명만 필요하면 OS 보안 저장소에 둔다. Carrier credential과 Resume secret은 사용자 파일을 포함한 디스크에 기록하지 않고 Client 프로세스 메모리에만 둔다.
- 로컬 앱의 경로·메서드·데이터 변경, 인증된 검토자의 화면 캡처·복사와 브라우저가 외부 origin에 직접 보내는 요청은 Tunnel의 앱 정책 범위가 아니다.
- Session 종료는 새 네트워크 접근과 열린 Stream을 막지만 이미 브라우저 cache, Service Worker 또는 사용자 파일로 전달된 사본을 회수하지는 못한다.
- 비저장·마스킹 규칙은 Ingress, Load Balancer, reverse proxy, Gateway, Client, 분산 추적과 오류 수집 도구 전체에 동일하게 적용한다.

## 11. 실패 처리와 관찰 가능성

### 11.1 외부 응답 정책

| 상황 | 응답 원칙 |
| --- | --- |
| 인증 세션 없음 | GET 최상위 브라우저 탐색만 Gateway 계정 로그인으로 이동한다. HEAD를 포함한 그 밖의 method와 API·SSE·WebSocket handshake는 body를 저장·재생하지 않고 `401 Unauthorized`와 사전 로그인 안내를 반환 |
| 계정 정책 위반 | Tunnel을 조회하지 않고 `403 Forbidden` |
| Tunnel별 비인가, 존재하지 않음 또는 만료 | 존재 여부를 구분하지 않는 동일한 `404 Not Found` |
| generic CONNECT 또는 websocket 이외 Upgrade | `501 Not Implemented`와 `UNSUPPORTED_CAPABILITY` |
| 재연결 유예 중 | `503 Service Unavailable`과 제한된 `Retry-After` |
| create provision receipt 누락·불일치 | provisional Session을 라우팅하지 않고 HMAC·원문 buffer를 폐기한 뒤 Carrier를 `PROVISION_RECEIPT_FAILED`로 종료 |
| Session configuration 미적용·불일치 | Session을 라우팅하지 않고 activation timeout 뒤 Carrier를 표준 `CONFIG_APPLY_FAILED` 또는 `CONFIG_ACK_TIMEOUT`으로 종료 |
| 신규 활성화 시 Ingress canary 실패 | URL을 사용 가능하다고 표시하지 않고 신규 활성화를 중단. 운영 알림과 rollback 판단 시작 |
| 로컬 연결 또는 WebSocket upgrade 실패 | local transport·protocol 실패만 응답 시작 전에 `502 Bad Gateway`. 로컬이 반환한 문법상 유효한 non-101 HTTP 응답은 status·header·body를 프록시 정책에 따라 전달 |
| local connect·response-header·upgrade timeout | 응답 시작 전에는 `504 Gateway Timeout` |
| 응답 시작 뒤 HTTP/SSE 중계 오류 | 기존 상태를 바꾸지 않고 downstream stream 종료 |
| WebSocket 101 이후 중계 오류 | HTTP 상태를 새로 보낼 수 없으므로 upgraded socket 종료 |
| 요청 크기 제한 초과 | 응답 시작 전에는 `413 Content Too Large`. 응답 시작 뒤에는 기존 status를 바꾸지 않고 Stream 종료와 `REQUEST_TOO_LARGE` 이벤트 |
| finite 응답 크기 제한 초과 | 응답 시작 전에는 `502`, 시작 뒤에는 stream 종료와 `UPSTREAM_RESPONSE_TOO_LARGE` 이벤트 |
| buffer·write-stall·stream inactivity 제한 초과 | 해당 Stream을 reset하고 유형별 표준 오류 기록 |
| 사용자·Tunnel rate 또는 동시 Stream 제한 초과 | 새 요청·handshake에 `429 Too Many Requests`과 제한된 `Retry-After` |
| Carrier 단절 | 열린 Stream은 재생하지 않고 종료. 새 요청은 Session 상태에 따라 `503` |
| 중계 프로토콜 오류 | 응답 전에는 `502`, 응답·upgrade 뒤에는 연결 종료와 추적 가능한 Stream ID |

오류 화면은 검토자가 다음 행동을 알 수 있게 설명하되 개발자 PC의 주소나 내부 스택은 표시하지 않는다.

Client 인증·대상 검증·프로토콜 버전 오류는 세션 등록을 거부하고 CLI에 원인과 해결 행동을 표시한다. 보안 오류를 이전 프로토콜이나 익명 연결로 fallback하지 않는다.

Control 인증이나 WSS handshake가 성공했더라도 configuration ACK, initial origin probe, Relay probe 또는 Registry binding 준비가 실패하면 `ACTIVE`가 아니다. CLI와 운영 화면은 `control connected`를 `tunnel ready`로 표현하지 않고 실패한 Readiness dimension을 표시한다.

SSE 재연결과 HMR WebSocket 재연결은 브라우저·프레임워크가 새 Stream을 만드는 동작이다. Relay는 끊어진 event, request body 또는 WebSocket bytes를 저장·재생하지 않는다.

### 11.2 이벤트와 로그

필수 Session·운영 이벤트:

- `tunnel.creating`
- `tunnel.provisioned`
- `tunnel.config_issued`
- `tunnel.config_applied`
- `tunnel.config_rejected`
- `tunnel.readiness_changed`
- `tunnel.active`
- `tunnel.reconnecting`
- `tunnel.resumed`
- `tunnel.closed`
- `tunnel.expired`
- `credential.revoked`
- `ingress.canary_failed`
- `ingress.canary_recovered`

필수 Stream 이벤트:

- `stream.opened`
- `stream.response_started`
- `stream.upgraded`
- `stream.completed`
- `stream.cancelled`
- `stream.reset`

Session·Stream lifecycle 로그의 최소 필드이며 이벤트 유형에 해당하는 값만 기록한다.

- timestamp
- Stream ID와 Request ID
- connection generation
- config revision, digest의 제한된 식별값과 desired·applied 일치 여부
- 변경된 Readiness dimension과 표준 reason code
- 익명화 또는 제한 노출된 Tunnel ID
- Stream 유형(`http-finite`, `http-stream`, `websocket`)
- HTTP method·status 또는 upgrade 결과
- open·response-start·close 시각과 duration
- 방향별 전송 byte 수
- 정상·비정상 close와 표준화된 reset/error code
- first-byte 지연과 flow-control 대기 시간

기록하지 않는 값:

- 요청·응답 본문
- SSE event와 WebSocket opaque bytes
- Cookie와 Authorization
- query string
- 관리자 발급 계정 세션, 비밀번호 및 Client token
- Session configuration 본문, Relay probe nonce와 로컬 origin 주소

동일한 제외 규칙을 Gateway 앞단 access log, Client debug log, trace span과 오류 수집 payload에도 적용하고 자동 수집 설정을 테스트한다.

필수 메트릭:

- 활성·생성·만료 터널 수
- 중계 연결 성공률과 재연결 성공률
- create provision receipt와 configuration ACK 성공률·지연·timeout, digest mismatch 횟수
- Readiness dimension별 활성화 실패 수와 control 연결 성공 후 Data Plane 활성화 실패 비율
- Ingress public-path canary 성공률·지연과 마지막 성공 시각
- Carrier credential 발급·소비·만료·회수·재사용 거부 횟수와 revocation 전파 지연
- 유형별 활성·생성·종료 Stream 수와 비정상 종료율
- HTTP 상태·Stream reset code별 오류율
- first-byte·upgrade·DATA 전달 p50/p95/p99 지연
- 방향별 전송량, connection·Stream window 고갈 시간과 queue high-water mark
- cancellation, write-stall, local 연결 실패, timeout과 protocol 오류 횟수

### 11.3 서비스 상태와 배포 gate

Gateway는 process liveness, instance traffic readiness와 Gateway admission readiness를 구분한다. liveness는 프로세스가 이벤트 루프와 기본 내부 점검에 응답하는지만 나타낸다. Load Balancer가 사용하는 instance traffic readiness는 Control Plane 의존성, Relay Data Plane 초기화, Registry 쓰기·조회와 credential 검증기처럼 인스턴스 내부 조건만 반영한다. 외부 Ingress canary는 이 신호에 넣지 않고 신규 Session 허용과 배포 판단에 쓰는 Gateway admission readiness로만 관리해 LB 제거와 canary 실패의 피드백 루프를 막는다. 외부 health endpoint에는 내부 주소·버전·정책을 노출하지 않고 세부 원인은 내부 메트릭과 운영 로그에서만 확인한다.

배포 시스템은 단순 HTTP `200`이나 Control WSS 연결만으로 후보 버전을 공개 트래픽에 투입하지 않는다. 후보는 pin된 version·config digest의 두 public-path probe를 먼저 통과하고 결과를 기록한 뒤 별도 승인을 받아야 배포 admission을 얻는다. 성공 기록만으로 자동 승인하지 않는다. 운영 중 canary 실패는 해당 identity의 승인을 폐기해 신규 Session 활성화를 차단하고 알림을 발생시키되, 메모리 Session을 보존해야 하는 가용성 장애에서는 자동 재시작·rollback하지 않는다. 운영자가 drain 또는 기존 Session 손실을 동반한 수동 rollback을 선택하며, 인증 우회 위험은 PostgreSQL에 영속되는 kill switch 뒤 긴급 rollback한다.

## 12. 기술 결정

| 주제 | MVP 방향 | 상태 | 근거 |
| --- | --- | --- | --- |
| 공유 URL | 기준 도메인의 랜덤 와일드카드 서브도메인 | MVP 확정 | 앱 경로를 바꾸지 않고 Session을 host로 라우팅 |
| 인증·제어 host | 콘텐츠 wildcard namespace 바깥의 고정 callback·control host. 기준 도메인은 운영자가 선택 | MVP 확정 | host-only Cookie와 정확한 Origin 검증으로 제어 endpoint를 보호 |
| Ingress routing | 사전 구성한 wildcard 단일 route로 모든 콘텐츠 host를 Gateway에 전달하고 Session route는 Registry에서 수행 | MVP 확정 | Tunnel별 설정 전파 지연과 프록시 제품별 동적 router 의존 제거 |
| 중계 연결 | `review-tunnel.v1` WSS Carrier 하나 | MVP 확정 | 연결 하나로 여러 Stream을 중계 |
| Relay 모델 | HTTP·SSE·WebSocket 공통 논리 Stream | MVP 확정 | 별도 파이프라인 없이 공통 수명주기·취소·flow control 사용 |
| SSE | 종료가 늦는 HTTP response stream | MVP 확정 | 별도 event protocol과 replay 저장소가 필요하지 않음 |
| 브라우저 WebSocket | HTTP 101 이후 opaque 양방향 byte relay | MVP 확정 | fragmentation·compression·ping/pong을 재구현하지 않고 보존 |
| HMR·Fast Refresh | 공식 지원 프레임워크의 MVP 인수 기준 | MVP 확정 | 로컬 개발 서버를 그대로 검토한다는 제품 목적의 핵심 |
| Origin projection | `local-view` 기본, `proxy-aware` opt-in | MVP 확정·구현 | Host·Origin 계열을 일관되게 유지하면서 proxy-aware 앱도 지원 |
| Gateway 내부 경계 | Control Plane과 Relay Data Plane을 논리 모듈로 분리한 단일 배포 단위 | MVP 확정 | 인증·수명주기와 byte 중계의 변경 이유를 분리하면서 초기 운영 복잡도는 늘리지 않음 |
| Session configuration | 작은 불변 snapshot + revision·digest + 명시적 적용 ACK | MVP 확정 | 설정 전송 성공과 실제 적용 성공을 구분하고 범용 설정 bus를 만들지 않음 |
| 활성화 gate | Session activation Readiness와 전역 Gateway admission Readiness의 논리곱 | MVP 확정 | Control 연결만 정상인 부분 장애를 사용 가능 상태로 오인하지 않고 Session·배포 상태를 분리 |
| Session Registry | 프로세스 메모리 | MVP 확정 | Gateway 재시작 때 기존 URL이 종료되는 제약을 승인했으며 MVP에는 영구 세션과 수평 확장이 필요하지 않음 |
| 검토자 인증 | 인증형 Gateway에서 관리자 발급 계정 + `REVIEWER` 권한 | MVP 확정 | 외부 IdP 없이 접근 대상을 관리자가 명시적으로 통제 |
| Client 로그인 | 인증형 Gateway에서 관리자 발급 계정 + `DEVELOPER` 권한, 로그인 세션을 Carrier credential로 교환 | MVP 확정 | 브라우저·CLI가 같은 계정 정책을 사용하되 Carrier 자격증명은 분리 |
| 계정 저장 | PostgreSQL | MVP 확정 | Gateway 재시작과 무관하게 계정·권한·세션·로그인 제한·감사를 보존하고 배포 위치와 무관하게 동일하게 사용 |
| 비밀번호 | Argon2id, 최소 15자, 임시 비밀번호 최초 변경 강제 | MVP 확정 | 평문·복호화 가능한 저장을 금지하고 자체 계정 운영 책임을 명시 |
| Carrier 인증 | control API가 발급한 짧은 수명·1회용 opaque credential을 WSS Authorization header로 전달 | MVP 확정 | 로그인 token 재사용과 URL token 유출을 막고 create·resume 목적을 분리 |
| Secret 저장 | 상태 저장소에는 Carrier·Resume·검토자 세션 원문 대신 용도별 HMAC lookup 값만 저장 | MVP 확정 | 원문은 발급·검증의 bounded transient buffer로 제한하고 지속 상태·로그 노출 시 재사용 가능한 비밀값 잔존 방지 |
| 배포 변경 통제 | Ingress·LB·필수 플러그인 버전과 config digest pinning, public-path canary, drain·rollback 정책 | MVP 확정 | 설정 유효성만으로 발견하기 어려운 route·middleware 부분 장애를 차단하고 메모리 Session 손실을 명시적으로 통제 |
| 배포 단위 | Linux 또는 컨테이너 환경에서 동일하게 실행 가능한 단일 Gateway | MVP 확정 | 핵심 흐름을 클라우드 제품에 종속시키지 않고 환경별 차이는 설정과 Ingress adapter로 격리 |
| 구현 언어 | TypeScript 5.9 + Node.js 24 | MVP 확정 | Phase 1 POC의 streaming·WebSocket·flow-control 검증을 통과하고 단일 코드베이스 유지 |
| TLS 종료 | 배포 환경의 Ingress·Load Balancer | 환경별 확정 필요 | 운영자가 선택한 DNS·인증서 구성과 고정 public-path canary를 사용 |

기술 선택은 요구사항을 충족하는 수단이다. Go, Node.js, Nginx, Caddy 같은 제품명은 POC 결과와 실제 배포 환경을 확인한 뒤 확정한다.

## 13. MVP 인수 기준

다음 조건을 모두 통과해야 MVP로 본다.

### 13.1 사용자 시나리오

- AC-01. 인증형 Gateway에서 인증된 개발자가 루프백 주소를 지정해 Client를 실행하면 candidate generation의 설정 적용과 최종 activation gate가 확인되고 current로 승격된 뒤에만 사용 가능한 공유 URL이 출력된다.
- AC-02. 인증형 Gateway에서 유효한 목적 제한 Carrier credential이 없거나 `review-tunnel.v1` profile과 일치하지 않는 Client는 Tunnel Session을 만들 수 없고 조용한 downgrade도 일어나지 않는다.
- AC-03. 인증형 Gateway에서 관리자가 발급하지 않았거나 비활성·권한 부족·미인증 상태인 계정은 HTTP body, SSE event 또는 WebSocket handshake를 로컬 앱까지 전달할 수 없다.
- AC-04. 호환성 매트릭스에 버전을 고정한 테스트 앱에서 초기 화면, client navigation, 정적·binary 자산, API, 앱 Cookie, 압축 응답과 redirect E2E가 통과한다.
- AC-05. 표준 parser가 수용한 GET·POST·PUT·PATCH·DELETE·OPTIONS와 custom application method, method-override header가 공유 명령 외 메서드별 추가 opt-in 없이 보존된다. generic CONNECT와 websocket 이외 Upgrade만 `UNSUPPORTED_CAPABILITY`로 거부된다.
- AC-06. request와 response body가 전체 buffering 없이 chunk로 흐르고 첫 response chunk가 로컬 응답 종료 전에 브라우저에 도착한다.
- AC-07. SSE event 두 개가 upstream 종료 전에 순서대로 브라우저에 도착하고 `Last-Event-ID`가 로컬 앱까지 전달되며 Relay는 event를 replay하지 않는다.
- AC-08. WebSocket은 로컬 101 성공 뒤에만 브라우저 upgrade가 완료되고 text·binary, fragmentation, subprotocol, extension, ping/pong과 정상 close가 보존된다.
- AC-09. 호환성 매트릭스의 Vite에서 JS·CSS 수정, 오류 overlay와 복구가 수동 새로고침 없이 동작하고 HMR direct-fallback·mixed-content 오류가 없다.
- AC-10. 호환성 매트릭스의 Next.js에서 RSC streaming, client navigation, Route Handler·Server Action, Fast Refresh와 dev error overlay가 동작한다.
- AC-11. finite HTTP, SSE, WebSocket과 큰 download가 동시에 열려도 데이터가 섞이지 않고 heartbeat·HMR이 굶지 않으며 queue가 설정 상한을 넘지 않는다.
- AC-12. 브라우저 cancel, SSE disconnect와 WebSocket close가 설정 시간 안에 Client와 로컬 request·socket까지 전파되고 관련 buffer가 정리된다.
- AC-13. 로컬 앱 중단, handshake 실패, 재연결 중, 세션 만료와 유형별 timeout이 서로 구분되는 오류·종료로 표시된다.
- AC-14. 동일 Gateway 프로세스와 Registry entry가 유지된 Carrier 단절은 유예 시간 안에 같은 URL로 복구된다. 기존 HTTP·SSE·WebSocket은 종료되고 replay되지 않으며 이전 generation의 모든 메시지는 거부된다. 동시 resume 시도 중 CAS의 한 candidate만 승격 가능하고 나머지는 기존 Session을 바꾸지 않는다.
- AC-15. Gateway 재시작으로 Registry가 사라지면 Client가 resume 실패와 이전 URL 폐기를 표시하고 종료한다. 새 URL은 사용자가 공유 명령을 다시 실행할 때만 발급된다.
- AC-16. Gateway에 도달 가능한 상태에서 개발자가 종료하면 `close propagation timeout` 안에 모든 Stream과 URL이 제거된다. 이미 단절됐다면 Client는 로컬 Resume secret을 폐기하고 종료 미확인 상태를 표시하며 Gateway는 유예 만료 후 제거한다.
- AC-17. 활성 앱 Stream은 Session idle 만료를 막지만 최대 TTL과 검토자·개발자 authorization max-age는 적용된다. 만료 시 scope에 속하는 Stream과 URL 또는 Carrier가 종료되고 새 URL은 자동 발급되지 않는다.
- AC-17a. fake clock 또는 축약 시간 환경에서 최대 8시간, 활성 Stream이 없을 때 유휴 30분과 재연결 유예 2분의 경계 전후 상태 전이가 결정적으로 검증된다.
- AC-17b. 지원 대상 OS와 Chromium 계열 브라우저에서 호환성 매트릭스의 Vite·Next.js 테스트 앱 생성·접속·HMR·재연결·종료 E2E가 통과한다.

### 13.2 보안·운영

- AC-18. Gateway는 개발자 PC에 외부 listener를 열지 않고 외부 통신에 HTTPS/WSS를 사용한다.
- AC-19. Gateway 인증 Cookie와 내부 header가 HTTP·SSE·WebSocket 어느 경로에서도 로컬 앱에 전달되지 않으며, 검토자·Client 자격 증명을 서로의 endpoint에서 사용할 수 없다.
- AC-20. HTTP body, SSE event, WebSocket bytes, Cookie, Authorization, token, Session configuration 본문, Relay probe nonce와 로컬 origin 주소가 전체 중계 인프라의 로그·trace·오류 수집 정보에 남지 않는다.
- AC-21. 루프백 외 주소는 공유할 수 없고 health probe와 로컬 HTTP Client가 redirect를 자동 추적하지 않는다.
- AC-22. 모든 외부 요청은 Request ID를 가지며 중계된 논리 Stream은 Gateway와 Client에서 같은 Stream ID·generation으로 연결된다.
- AC-23. HTTP request 크기 제한이 response 시작 전에 초과되면 `413`, 시작 뒤 초과되면 기존 status를 바꾸지 않고 Stream 종료와 `REQUEST_TOO_LARGE` 이벤트를 남긴다. `http-finite` response 제한은 downstream response 시작 전이면 `502`, 시작 뒤면 기존 status를 바꾸지 않고 Stream 종료와 `UPSTREAM_RESPONSE_TOO_LARGE` 이벤트를 남긴다.
- AC-24. SSE·WebSocket은 누적 response 크기로 종료하지 않고 buffer·전송률·inactivity·최대 지속 시간·동시 Stream 제한을 각각 적용한다.
- AC-25. rate 또는 새 Stream 동시성 제한을 초과하면 `429`와 표준 오류 이벤트가 남는다.
- AC-26. 실제 Ingress·Load Balancer를 포함한 환경에서 custom method·method-override header가 보존되고, 전체 upload 종료 전에 첫 request chunk가 로컬 앱에 도착하며, WebSocket Upgrade, SSE no-buffer flush, cancellation과 장기 timeout이 동일하게 동작한다.
- AC-27. 콘텐츠 shared cache가 비활성화되어 한 검토자의 인증된 응답이 다른 사용자나 Session 종료 후 새 네트워크 요청에 재사용되지 않는다.
- AC-28. create의 정확한 provision receipt, candidate generation의 revision·digest가 담긴 `CONFIG_APPLIED`, Relay probe와 Gateway admission 성공 전에는 candidate가 current로 승격되거나 Session이 외부 요청을 중계하지 않는다. `SESSION_ACTIVE`는 같은 Carrier의 모든 `OPEN_HTTP`보다 FIFO상 먼저 처리된다.
- AC-29. 정확히 같은 configuration ACK 중복은 idempotent하고 ACK timeout에는 동일 snapshot을 한 번만 재전송한다. stale generation, digest mismatch와 명시적 적용 실패는 candidate Carrier를 fail-closed하며, create provisional Session은 제거하고 resume Session은 기존 상태를 재연결 유예 동안 유지한다.
- AC-30. 인증형 Gateway의 Control 인증·WSS가 성공했어도 initial origin, Relay Data Plane, Registry binding 또는 Gateway admission이 실패하면 CLI와 운영 지표가 원인을 구분하고 `control connected`를 `tunnel ready`로 보고하지 않는다.
- AC-31. 인증형 Gateway의 Carrier credential은 짧은 TTL·1회 사용·create/resume purpose·control audience 제한을 가지며 `Authorization` header 외 위치의 값과 만료·회수·재사용된 값은 거부된다. Registry·DB·cache에는 Carrier·Resume·검토자 세션 secret의 용도별 HMAC만 남고 원문은 발급·검증 중 bounded transient buffer에서만 처리된 뒤 해제·수집 제외된다.
- AC-32. 공유 URL·Tunnel ID와 URL bearer token만 가진 사용자는 접근할 수 없다. 원래 application query는 서버 측 one-time record에 남으며, host 교환 값은 대상 host에 바인딩되어 한 번만 소비되고 제거되지만 원래 application URL은 보존된다.
- AC-33. 인증형 Gateway의 검토자 회수는 해당 검토자의 새 요청과 진행 중 finite HTTP·streaming/SSE·WebSocket을, 개발자·Tunnel 회수와 kill switch는 해당 Tunnel의 새 요청·resume·모든 Stream·Carrier를 Gateway의 revocation propagation SLO 안에 종료한다. 이전 generation은 되살아나지 않는다.
- AC-34. 인증형 Gateway의 Tunnel 생성·재연결·종료 전후 Ingress·DNS·인증서 설정은 동일하다. pin된 실제 Ingress 경로에서 미인증 negative probe와 별도의 authenticated request streaming·SSE·WebSocket canary가 모두 통과한다. 실패 시 신규 admission 차단과 운영자가 선택한 drain 또는 Session 손실을 명시한 rollback 절차가 검증된다.

### 13.3 품질 검증

- 순수 도메인 로직은 테스트를 먼저 작성한다.
  - Tunnel 상태 전이
  - Session activation·Gateway admission 파생 조건과 상태·route 원자 전이
  - Session configuration canonical encoding, revision·digest와 desired·applied 판정
  - 논리 Stream의 양방향 상태 전이와 terminal 불변식
  - 접근 허용 판단
  - Tunnel ID 라우팅
  - Origin projection과 header·Cookie 변환 정책
  - protocol version, generation, configuration ACK와 flow-control 판정
  - 유형별 timeout과 제한 판정
- Client–Gateway protocol contract test로 모든 v1 메시지, provision receipt 누락·불일치, configuration ACK 누락·중복·stale generation·digest mismatch, activation commit 직전·직후 Carrier 단절, `SESSION_ACTIVE` 유실 뒤 같은 URL resume, barrier상 `OPEN_HTTP` 선행 금지, 동시 resume single-winner와 bounded retry, Relay probe, HTTP→UPGRADED_RAW 전이, 양방향 head bytes, half-close, cancel, terminal race, generation fencing, window와 버전 오류를 검증한다.
- fixture origin 통합 테스트로 HTTP method·body streaming·압축·SSE·WebSocket raw upgrade·동시성·취소와 오류 매핑을 검증한다.
- slow producer·consumer와 큰 download 테스트로 bounded memory, backpressure와 Stream 공정성을 검증한다.
- Control Plane 인증 성공과 Data Plane·initial origin 실패를 독립적으로 주입하고, 외부 canary 실패가 instance traffic readiness를 내리지 않는지 검증한다.
- Carrier credential의 audience·purpose·expiry·1회 소비·회수와 secret HMAC 검증, URL·로그·진단 bundle 비노출을 테스트한다.
- 아키텍처 경계 검사로 Relay Data Plane이 Session·권한·credential을 생성하지 않고 Control Plane이 앱 payload에 의존하지 않는지 검증한다.
- 여러 Tunnel 생성·재연결·종료 전후 Ingress configuration digest가 변하지 않는지 확인한다.
- 공식 지원 Vite·Next.js 버전마다 실제 Ingress를 통과하는 브라우저 E2E 테스트를 수행한다.
- pin된 배포 후보 Ingress에서 외부 미인증 negative probe와 자격·네트워크가 제한된 authenticated fixture를 분리해 TLS·인증 차단·request streaming·SSE no-buffer·WebSocket Upgrade와 rollback을 검증한다.
- 구현 후 단위·통합·E2E 테스트, 아키텍처 경계 검사와 전체 빌드를 통과해야 한다.

## 14. 개발과 출시 단계

### Phase 0 — 결정과 테스트 기준 확정

- 관리자 발급 계정 역할, 비밀번호·세션 수명, 관리자 생성·정지·초기화와 회수 정책 확정
- PostgreSQL 백업·복구, HMAC key 회전과 최악의 회수 전파 지연 확인
- 운영자가 선택한 기준 도메인에서 control host·콘텐츠 wildcard DNS·TLS 운영 방식과 기존 `Domain` Cookie 영향 확인
- 와일드카드 단일 Ingress route, pin 대상 버전·config digest, 예약 canary host와 rollback 방식 확정
- outbound-only 연결, HTTP 양방향 streaming, raw WebSocket upgrade, cancellation, bounded memory·flow control과 인증 hook을 기준으로 `review-tunnel.v1` 구현에 재사용할 multiplexing·flow-control 라이브러리와 직접 framing 범위를 비교하는 ADR 작성
- 선택한 전송의 message envelope, END 의미, 오류 code와 초기 window·queue 상한을 Phase 1 시작 전에 확정
- Session configuration canonical encoding, revision·digest, 적용 ACK, Relay probe와 activation timeout 계약 확정
- HTTP·streaming·WebSocket별 timeout과 자원 제한의 초기값 확정
- 초기 지원 OS와 Chromium 계열 브라우저를 정하고 Vite·Next.js·Node·bundler의 정확한 버전과 테스트 앱 선정
- `local-view`·`proxy-aware` Origin projection 계약 확정
- POC 평가 기준과 보안 체크리스트 작성
- Carrier credential TTL·1회 소비·purpose·audience, secret HMAC key 관리와 revocation propagation SLO 확정

### Phase 1 — 격리된 Tunnel POC

목표는 다음 핵심 경로의 기술적 가능성을 검증하는 것이다.

    테스트 브라우저 → Gateway → 중계 연결 → Client → 로컬 앱

검증 항목:

- 여러 동시 HTTP 요청의 양방향 body streaming과 half-close
- `Expect: 100-continue`, informational 1xx와 trailer를 MVP 보장 범위에서 제외
- SSE 첫 chunk 즉시 flush와 browser cancel 전파
- WebSocket handshake, 101 이후 raw byte 중계와 정상·비정상 close
- text·binary·compression·subprotocol HMR 트래픽의 의미 보존
- 큰 download 중 heartbeat·HMR 공정성과 bounded-memory backpressure
- Carrier 단절 시 열린 Stream 폐기, generation fencing과 Session resume
- create의 `SESSION_PROVISIONED → SESSION_CONFIG → CONFIG_APPLIED → OPEN_PROBE/DATA → SESSION_ACTIVE` 흐름, resume의 single candidate CAS와 receipt·ACK timeout·stale generation·digest mismatch
- Control 연결은 성공하지만 initial origin 또는 Relay Data Plane이 실패하는 조합의 장애 주입
- 고정 버전 Vite HMR와 Next.js Fast Refresh·RSC streaming·Server Action
- 실제 후보 Ingress의 고정 wildcard route, Upgrade, no-buffer, request streaming, 장기 timeout과 예약 canary
- 여러 Session 생성·종료 전후 Ingress configuration이 변하지 않는 경계 검증
- Go와 Node.js 후보의 raw upgrade 제어, 구현 복잡도와 자원 사용량

POC는 인증과 HTTPS가 빠질 수 있으므로 격리된 개발 환경에서만 실행한다. 신뢰되지 않은 네트워크에 공개하지 않는다.

단일 WSS에서 bounded memory와 공정성을 만족하지 못하면 buffer를 늘리지 않고 control 연결과 복수 데이터 Carrier 같은 전송 어댑터 대안을 비교한다. Session·Stream 상태기계는 이 선택에 의존하지 않게 유지한다.

### Phase 2 — 보안 포함 MVP

- 관리자 발급 계정 로그인·관리자 UI와 `REVIEWER` 접근 정책
- `DEVELOPER` 권한 Client 로그인과 짧은 수명·1회용 Carrier credential 교환
- Carrier·Resume·검토자 세션 secret의 용도별 HMAC 저장과 회수
- 고정 와일드카드 Ingress·도메인·TLS, version pinning과 public-path canary
- `review-tunnel.v1` HTTP streaming·SSE·WebSocket Relay
- Session configuration ACK, activation Readiness, lease와 재연결
- Origin projection, header·Cookie 정책과 유형별 운영 제한
- 장기 Stream 인증 수명, 오류 화면, 로그와 메트릭
- 공식 지원 Vite·Next.js 브라우저 E2E
- CLI 기본 사용 흐름
- 검토자·개발자·Tunnel 회수와 kill switch의 실제 열린 Stream 종료·전파 SLO

이 단계의 보안·품질 인수 기준을 통과한 뒤에만 인증형 Gateway를 공개한다.

2026-08-25 기준 애플리케이션 코드와 로컬 자동 검증은 완료했다. 실제 DNS·TLS·Ingress, secret manager, PostgreSQL 복구 drill, 대상 브라우저·프로젝트와 운영 소유권은 배포 환경 인수 항목으로 남는다. 상세 증거와 실행 절차는 [`poc-status.md`](poc-status.md)와 [`linux-deployment.md`](linux-deployment.md)를 따른다.

### Phase 3 — 화면 맥락 리뷰 MVP

- stable Project·Review revision·Tunnel binding 저장 모델
- 예약 Review API와 기존 content session 역할 검사 결합
- 페이지 댓글과 클릭 위치 영역 핀
- 답글, 해결·다시 열기와 SSE 실시간 갱신
- Shadow DOM overlay와 Vite·Next.js·generic integration
- 댓글 입력의 XSS·CSRF·rate limit·프로젝트 격리 테스트
- 새 Tunnel에서도 동일 Project·revision 댓글이 유지되는 E2E

세부 범위와 인수 기준은 [`contextual-review.md`](contextual-review.md)를 따른다. 이 단계가 끝나기 전에는 README와 릴리스 노트에서 화면 댓글 기능을 구현 완료로 표시하지 않는다.

### Phase 4 — 제한된 파일럿

- 소수 개발자와 검토자에게 opt-in 제공
- 지원 매트릭스의 프로젝트 종류와 버전 폭 확대
- 연결 성공률, 오류율, 추가 지연과 사용성 측정
- 페이지 댓글 대비 영역 핀 사용 비율, 해결률과 anchor 이탈률 측정
- 지원 범위와 운영 기본값 조정
- config ACK·Readiness dimension별 실패, Ingress canary와 revocation 전파 지연 측정
- 중단·롤백 절차 검증

### Phase 5 — 운영 보강

파일럿의 호환성·운영 지표와 사용자 피드백을 근거로 16장의 확장 후보 중 필요한 항목만 우선순위화한다.

## 15. 결정 기록과 남은 항목

### 15.1 제품 소유자 확정 사항

| 항목 | 확정 내용 |
| --- | --- |
| 접근 대상 | 관리자가 `REVIEWER` 권한을 부여한 활성 계정 중 공유 URL을 아는 사용자 |
| 계정 생성 | 최초 관리자는 Linux CLI에서 1회 bootstrap, 이후 관리자는 웹 UI 또는 인증된 CLI 사용 |
| 비밀번호 복구 | 공개 이메일 복구 없이 관리자가 일회용 임시 비밀번호로 초기화 |
| 공유 범위 | 개발자가 선택한 단일 로컬 origin 전체. 데이터 변경 API와 HTTP·SSE·WebSocket·HMR 포함 |
| 세션 | 최대 8시간, 활성 Stream이 없을 때 30분 유휴 만료, 재연결 유예 2분 |
| 초기 지원 | Node.js 24 Client, Chromium 계열 브라우저, 고정 버전 Vite·Next.js fixture |
| 재시작 정책 | Gateway 재시작 시 기존 Session과 URL 종료 허용 |
| 도메인 설정 | 실제 콘텐츠·control host를 환경 변수로 주입하고 시작 시 control의 wildcard namespace 분리·예약 host 불변식 검증 |
| 배포 대상 | Linux 또는 컨테이너 환경. 동일 Gateway image와 환경별 Ingress adapter 사용 |
| 제품 방향 | 범용 터널이 아니라 로컬 웹앱의 페이지·영역 피드백과 해결 흐름에 집중 |
| 리뷰 데이터 | Project·Review revision에 영속하고 Tunnel ID에는 임시 binding만 유지 |
| 오버레이 | 명시적으로 활성화한 개발 서버 integration과 Gateway 예약 API 사용. 전체 HTML 자동 rewrite는 기본값으로 사용하지 않음 |

### 15.2 구현·운영 추적 항목

| ID | 결정할 내용 | 현재 상태·남은 확인 | 확정 시점 |
| --- | --- | --- | --- |
| D-01 | MVP 접근 정책 | **확정:** 관리자 발급 활성 계정 + `REVIEWER` 권한 + 공유 URL | 완료 |
| D-02 | 계정 정책 | **확정:** 공개 가입 없음, 관리자 발급, 최초 변경 임시 비밀번호, ADMIN·DEVELOPER·REVIEWER | 완료 |
| D-03 | Client 로그인 방식 | **구현 완료:** 인증형 Gateway의 로그인 세션을 60초·1회용 create/resume Carrier credential로 교환하고 create Tunnel ID는 Gateway가 발급 | 완료 |
| D-04 | 도메인·TLS·Ingress 운영 | **코드·runbook 완료:** 운영자가 선택한 기준 도메인의 canonical public origin, control/wildcard namespace 경계, 예약 bearer canary host와 배포 identity 검증. 실제 host·인증서·Ingress 제품과 digest 승인은 환경별 남음 | 배포 전 |
| D-05 | 세션·활성화 정책 | **구현 완료:** 8시간·30분·2분, 10초 activation, config ACK·origin·Relay·route·admission gate | 완료 |
| D-06 | 콘텐츠 Cookie 격리 | **구현 완료:** host-only 유지, effective Domain 제거, parent/shared Domain과 예약 Cookie 거부. 기준 도메인을 공유하는 기존 서비스의 `Domain` Cookie 확인은 환경별 남음 | 파일럿 전 |
| D-07 | Relay 구현과 protocol v1 wire 형식 | **구현 완료:** canonical config·revision·digest·ACK·probe, generation, 오류 code, window·queue 계약 | 완료 |
| D-08 | 유형별 제한 | **구현 완료:** finite HTTP·SSE·WebSocket timeout, request·response 크기, buffer, 동시성, 분당 rate를 env로 노출 | 완료 |
| D-09 | 성능·용량 목표 | 제한과 회귀 테스트는 완료. 실제 first-byte·HMR 지연과 동시 Tunnel 용량 목표는 파일럿 지표로 확정 | 파일럿 중 |
| D-10 | 공식 호환 범위 | **자동 검증 고정:** Node 24, Chrome, Vite 8.2.2, Next.js 16.3.2, React 19.2.8. 실제 대상 브라우저·프로젝트 확인은 환경별 남음 | 파일럿 전 |
| D-11 | 로그 정책 | **코드 완료:** body·secret 비저장, HMAC Tunnel reference와 low-cardinality metrics. 보존 기간·접근 권한은 운영 정책 확정 남음 | 공개 전 |
| D-12 | 장애 책임 | rollback·drain·kill switch runbook 완료. 운영 소유자·알림 담당자·공지 책임자 지정은 운영 정책 확정 남음 | 공개 전 |
| D-13 | Credential 정책 | **구현 완료:** 60초·1회용·purpose·audience, active/previous HMAC overlap과 메모리 Resume secret | 완료 |
| D-14 | 회수 운영 | **구현 완료:** 기본 5초 `auth_version` 확인, DB 오류 fail-closed, authorization max-age와 PostgreSQL 영속 kill switch. 정확한 SLO·소유자는 파일럿 승인 남음 | 파일럿 전 |
| D-15 | Ingress 변경 통제 | version·digest pinning, admission과 독립된 canary, 결과 기록 뒤 별도 PostgreSQL 승인, drain·rollback 절차와 검사 스크립트 완료. 실제 환경 훈련 남음 | 배포 전 |
| D-16 | 화면 맥락 리뷰 | **방향 확정·구현 전:** Project·revision 기반 페이지 댓글, 영역 핀, 답글·해결 상태. 선택적 Shadow DOM overlay와 예약 Review API 사용 | Phase 3 |

## 16. 향후 확장 후보

- 특정 사용자·그룹 초대와 접근 회수
- 프로젝트별 고정 URL과 사용자 지정 별칭
- 사용자 지정 만료와 예약 종료
- 프로젝트 목록, 연결 상태와 요청 로그 Dashboard
- `data-review-id` 기반 안정적인 요소 anchor
- 사용자 확인을 거치는 선택적 스크린샷
- 댓글 멘션·알림과 Git Pull Request 연동
- 여러 포트와 선택적 사설망 대상 공유
- 로컬 HTTPS origin, custom CA와 명시적 self-signed 인증서 정책
- HTTP/2 wire semantics, native gRPC, WebTransport와 QUIC
- 복수 데이터 Carrier와 우선순위 전송
- CLI 자동 업데이트와 OS별 패키지 배포
- 수평 확장과 분산 Session Registry
- 지역별 Relay와 대용량 전송 최적화

확장 기능은 기존 중계 흐름의 조건문을 늘리는 방식보다 선택적 정책, 프로토콜 capability, 저장소 또는 전송 어댑터로 추가한다. 사용하지 않는 기능은 다른 영역을 수정하지 않고 제거할 수 있어야 한다.

## 부록 A. Pangolin 참고 분석과 채택 경계

Pangolin은 WireGuard 기반의 영구 원격 접근 플랫폼으로 public reverse proxy, private network, Site·Resource·조직·역할과 다중 Connector를 함께 관리한다. Review Tunnel은 개발자 프로세스 수명에 묶인 단일 loopback 웹 origin을 다른 기기의 브라우저에 임시 공유하므로 제품 범위와 운영 모델이 다르다. 이 문서는 Pangolin을 구현 기반이나 런타임 의존성으로 채택하지 않고 운영 패턴과 실패 시나리오만 참고한다. 분석 기준은 Pangolin 공식 [시스템 아키텍처](https://docs.pangolin.net/development/system-architecture), [Resource 모델](https://docs.pangolin.net/manage/resources/understanding-resources)과 저장소 commit [`fd0a0818`](https://github.com/fosrl/pangolin/tree/fd0a0818c187304f2cf3df9fa91d1e4b8de5530d)이다.

### A.1 채택하거나 축소 적용한 패턴

| Pangolin 패턴 | Review Tunnel 적용 |
| --- | --- |
| Control Plane과 Data Plane 책임 분리 | 물리적 서비스나 별도 네트워크를 만들지 않고 단일 Gateway 내부의 논리 모듈과 의존성 경계로 적용 |
| Connector 배치와 Resource 공개 분리 | Carrier가 연결됐다는 이유만으로 URL을 열지 않고 명시적 Session configuration·Readiness gate 뒤 Registry route 활성화 |
| deny-by-default | Gateway의 계정 정책, 고정 loopback 대상, `ACTIVE` Session이 확인된 트래픽만 Relay에 전달 |
| configuration version과 재동기화 | 범용 config bus 대신 세션별 작은 불변 snapshot, revision·digest와 명시적 `CONFIG_APPLIED` ACK 사용 |
| 연결 상태와 target 상태 구분 | lifecycle enum을 늘리지 않고 Session의 control·Carrier·config·origin·Relay readiness와 전역 Gateway admission을 독립적으로 관찰 |
| 장기 credential과 임시 session credential 분리 | 개발자 로그인 context를 짧은 수명·1회용 Carrier credential로 교환하고 Resume·검토자 세션과 audience·저장을 분리 |
| 인증 후 proxy | HTTP와 WebSocket 모두 Control Plane의 인증·인가를 통과한 뒤에만 Relay Data Plane에서 Stream 생성 |

### A.2 채택하지 않은 범위

- WireGuard, Gerbil, NAT hole punching, P2P·UDP relay와 OS network route
- `NET_ADMIN`·`SYS_MODULE` 같은 Client·Gateway의 네트워크 관리자 권한
- Tunnel마다 Traefik router·middleware·인증서 설정을 만들고 전파하는 동적 Ingress 구조
- 영구 Site·Resource DB, 조직 RBAC 편집 UI, 다중 target load balancing·failover
- 로그인 없이 URL·access token 소지만으로 접근하는 bearer shareable link
- 요청 header·query·원문 URL을 장기 저장하는 상세 request analytics
- 검토자 신원을 로컬 앱 header에 기본 주입하는 기능

Review Tunnel은 고정 wildcard Ingress와 Gateway의 메모리 Registry route를 사용한다. Pangolin 예제처럼 외부 프록시가 주기적으로 동적 설정을 가져오는 방식은 임시 Session 생성의 필수 경로에 두지 않는다. 관련 구현 예시는 Pangolin의 [Traefik 설정](https://github.com/fosrl/pangolin/blob/fd0a0818c187304f2cf3df9fa91d1e4b8de5530d/config/traefik/traefik_config.yml)과 [Compose](https://github.com/fosrl/pangolin/blob/fd0a0818c187304f2cf3df9fa91d1e4b8de5530d/compose.example.yaml)를 참고하되 복제하지 않는다.

### A.3 운영 실패 사례에서 도출한 검증 조건

다음 GitHub issue는 개별 사용자 제보이며 Pangolin 전체의 구조적 결함을 증명하지 않는다. 다만 분산된 터널 시스템에서 발생할 수 있는 부분 장애의 재현 시나리오로 사용한다.

- Control WebSocket은 연결됐지만 WireGuard Data Plane이 준비되지 않아 요청이 실패한 [#3433](https://github.com/fosrl/pangolin/issues/3433)에서 `control connected != tunnel ready` 원칙과 구성 요소별 Readiness를 도출했다.
- DB·Resource·TLS와 Client WS가 존재해도 proxy mapping이 적용되지 않았다고 보고된 [#3354](https://github.com/fosrl/pangolin/issues/3354)에서 desired·applied revision ACK와 실제 Relay probe를 도출했다.
- 프록시·plugin 버전 조합으로 router가 비활성화됐다고 보고된 [#3435](https://github.com/fosrl/pangolin/issues/3435)에서 floating version 금지, config digest pinning, 실제 public-path canary와 rollback gate를 도출했다.

### A.4 라이선스 경계

Pangolin 저장소는 헤더가 없는 파일을 기본 AGPL-3으로 두고 일부 파일에는 Fossorial Commercial License를 적용한다. Review Tunnel은 문서와 공개 아키텍처의 일반 원칙만 참고하고 Pangolin·Newt·Gerbil·Badger의 소스, 고유 프로토콜이나 설정을 복사하지 않는다. 코드 재사용이나 결합이 필요해지면 파일별 헤더와 분석 기준 commit의 [저장소 LICENSE](https://github.com/fosrl/pangolin/blob/fd0a0818c187304f2cf3df9fa91d1e4b8de5530d/LICENSE)를 확인하고 필요한 라이선스 검토를 먼저 수행한다.
