# Review Tunnel 보안 MVP 구현 상태

- 상태: 공유 기반·화면 맥락 리뷰 MVP 구현, 로컬 통합 검증 완료; 정식 운영 인수 대기
- 기준일: 2026-09-07
- 제품 방향 갱신: 2026-08-31
- 런타임: TypeScript 5.9, Node.js 24
- Carrier profile: `review-tunnel.v1`

> [!NOTE]
> 이 문서는 `0.1.0` 공유 기반과 화면 맥락 리뷰 MVP의 통합 상태를 기록한다. 기존 HTTPS 파일럿 결과는 리뷰 기능 통합 전의 공유·인증 검사이며, 새 리뷰 기능의 실제 HTTPS 운영 검증을 의미하지 않는다. 기능 범위는 [화면 맥락 리뷰 설계](contextual-review.md)를 따른다.

## 완료한 애플리케이션 범위

- Gateway가 발급하는 인증 모드 Tunnel ID·공유 URL과 `SESSION_PROVISIONED → SESSION_CONFIG → CONFIG_APPLIED → OPEN_PROBE → SESSION_ACTIVE` 활성화 장벽
- configuration revision·canonical digest·provision receipt 검증, 동일 ACK 멱등 처리, 1회 재전송과 activation timeout
- generation fencing, heartbeat·lease, 8시간 최대 수명·30분 유휴·2분 resume 유예와 CLI bounded exponential reconnect
- `localhost`의 모든 DNS 결과 loopback 검증, 연결 가능한 IP literal 고정과 resume 시 local-origin fingerprint 고정
- 일반 HTTP body streaming, SSE, WebSocket raw byte relay와 Stream·Carrier flow control
- 닫힌 Stream에 늦게 도착한 flow-control 갱신의 안전한 무시와 Gateway 종료 시 Upgrade socket 회수
- `local-view`·`proxy-aware` Origin projection, untrusted forwarding header 제거, Host·Origin·Referer 재구성
- 인증 Client의 Control HTTPS와 Carrier WSS를 동일 host·port에 결합하고 loopback 밖 평문 secret 전송을 거부하는 endpoint trust 경계
- 로컬 절대 `Location`·`Refresh`의 public origin 변환과 `Set-Cookie` Domain·예약 Cookie 격리
- WebSocket `Sec-WebSocket-Accept` 검증, generic CONNECT와 WebSocket 이외 Upgrade 명시적 거부
- request body·finite response 크기, 응답 header·inactivity·최대 지속 시간, 동시 Stream·분당 새 Stream 제한
- 관리자 발급 계정, host별 content session, 60초·1회용·purpose 제한 Carrier credential과 HMAC key overlap 회전
- 인증 정책을 Tunnel 조회보다 먼저 적용해 미인증 사용자에게 Tunnel 존재 여부를 노출하지 않는 경계
- 개발자·검토자 authorization max-age와 `auth_version` 회수, 현재 Stream·Carrier·resume 폐기
- HMAC 익명 Tunnel reference를 쓰는 구조화 수명주기 로그, low-cardinality Prometheus 메트릭과 별도 bearer 보호
- PostgreSQL에 영속되는 관리자 재인증 kill switch, 배포 identity별 canary 결과와 별도 admission 승인 gate
- PostgreSQL custom-format 원자 백업 및 확인 문자열이 필요한 파괴적 복구 스크립트
- admission·kill switch·Tunnel과 독립된 bearer 인증 예약 host에서 미인증 차단·request streaming·SSE·WebSocket을 검사하는 public-path canary
- 실패한 resume candidate의 정리와 generation 재사용 방지, 권한 DB 재검증 장애의 fail-closed 종료
- Gateway·Admin CLI·Client·canary-check 역할별 non-root Docker target
- CI의 실제 PostgreSQL·framework 완료 게이트와 여섯 production Docker target build·entrypoint smoke
- 하나의 기준 도메인 아래에서 control host와 콘텐츠 wildcard를 분리하는 인증형 Gateway 구성
- 잘못된 Upgrade 주소의 400 응답, 모든 연결 단계의 kill switch 정리, HTTP·WebSocket의 전송 대기와 종료 순서 보장
- DB idle 연결 오류의 프로세스 종료 방지와 저장된 admission 상태를 따르는 복구
- 브라우저의 정확한 Origin 검사·폼 CSP를 유지하는 로그인·비밀번호 변경 후 공유 화면 복귀

- 별도 review 도메인 패키지의 Project·Review revision·Tunnel binding·PAGE comment 규칙과 저장소 포트
- `--review-project`·`--review-revision` opt-in, Tunnel 활성화 뒤 binding, 실패 시 보상 종료와 성공 전 URL 비공개
- PostgreSQL review schema와 소유자별 project, project별 revision, 정확한 Tunnel session binding 및 path 댓글 격리
- 인증 선행, 역할·exact Origin·body 제한·`no-store`·예약 path 격리를 적용한 별도 Review Control/Content HTTP adapter
- plain text만 렌더링하는 Shadow DOM sidebar와 `pushState`·`replaceState`·`popstate` path 갱신
- additive PostgreSQL migration으로 저장하는 plain-text 답글과 기존 Phase 1 thread row 호환성
- `DEVELOPER`의 해결·다시 열기, `expectedStatus` transaction 비교와 409 충돌 노출
- `PAGE` 호환 `REGION_V1` 값 객체, 클릭 핀·드래그 영역, scroll·resize 재배치와 핀·목록 상호 강조
- PostgreSQL transaction event log, 단조 cursor replay, heartbeat·연결·배압·보존 제한과 stale authorization을 적용한 Review SSE
- 작성자 전용 수정, 작성자·`DEVELOPER` 삭제, 본문을 제거하는 tombstone과 `expectedVersion` 경합 처리
- project·revision 참여자로 제한한 `@username` 멘션, 자기·중복 제거와 수신자별 읽음·안 읽음 내부 알림
- generic bootstrap을 유지하는 dev-only Vite plugin과 Next.js config·root-layout integration
- 최신 100개를 보장하는 댓글·답글 keyset pagination, 전체 열린 댓글 수와 안정적인 영역 핀 번호
- session 최대 수명에 맞춘 binding 만료·선별 회수와 SSE burst 단일 in-flight·dirty 후속 조회
- 비공개 workspace 의존성이 없는 Vite·Next 컴파일 tarball과 Next production HTML bootstrap 차단

## 통합 코드 검증 결과

2026-09-06~07에 공유 기반 수정과 화면 맥락 리뷰 MVP를 통합한 코드로 `npm run check:mvp`를 실행했다. Node.js 24.12.0, macOS arm64, Chrome, 격리된 PostgreSQL 17.6을 사용했다.

| 검사 | 결과 |
| --- | --- |
| Biome·TypeScript·아키텍처 경계·빌드 | 통과 |
| 애플리케이션·패키지 테스트 | 328개 통과, 실패·건너뜀 0개 |
| 스크립트·배포·외부 패키지 설치 검사 | 51개 통과 |
| 실제 브라우저 시나리오 | 4개 통과 |
| 운영 Docker 이미지 | 6종 빌드·실행 진입점·non-root·MIT 포함 확인 |
| npm 운영 의존성 감사 | 루트 및 별도 runtime manifest 모두 알려진 취약점 0개 |

브라우저는 Vite의 로그인·HMR·권한 회수, Next.js의 초기 비밀번호 변경·RSC·Server Action·탐색·Fast Refresh·권한 회수, Next production HTML의 리뷰 스크립트 제외, 리뷰 오버레이의 댓글·답글·영역 핀·실시간 갱신·수정·삭제·멘션·알림·CSP·XSS·장애 표시를 검사했다. 로컬 HTTP와 테스트 저장소를 쓰는 오버레이 시나리오이며, PostgreSQL 저장·권한 경합은 별도 실연동 테스트로 확인했다.

통합 과정에서 다음 두 누락을 보완했다.

- Gateway 종료 시 이미 연결이 끊긴 세션의 리뷰 binding DB 정리도 완료될 때까지 기다린다.
- 관리자 `migrate`가 리뷰 테이블도 생성한다. 빌드한 Admin CLI Docker 이미지에서도 리뷰 테이블 9개 생성과 반복 실행을 확인했다. 수정 전에는 실제 DB에서 `rt_review_projects`가 없다는 오류를 재현했고, 수정 후에는 빈 DB와 기존 인증 DB의 업그레이드·반복 실행을 통과했다.

위 결과는 실제 운영 서버를 새 코드로 교체하거나 새 리뷰 기능을 공개 HTTPS에서 검증했다는 뜻은 아니다. 기존 HTTPS 파일럿은 아래 기록처럼 공유·인증 범위에 한정한다. 프로젝트별 사람 접근 목록도 아직 없다.

## 기존 공유 기반 자동 검증 결과

2026-09-06에 Node.js 24.12.0·macOS·Chrome에서 `npm run check:mvp`를 통과했다. 이번 리뷰와 개선 범위는 [전체 코드 리뷰 보고서](code-review-2026-09-06.md)에 기록했다.

- `npm test`: 285개 통과, 실패·건너뜀 0개. 격리된 PostgreSQL 15에 연결해 실행했다. PostgreSQL 실연동 항목은 `TEST_DATABASE_URL`이 없을 때만 명시적으로 건너뛴다.
- `npm run test:scripts`: 48개 통과
- `npm run test:frameworks`: 2개 통과
  - 공통: 개발자 API 로그인·Carrier 발급, 검토자 브라우저 로그인, 호스트별 HttpOnly 쿠키, 권한 회수에 따른 WebSocket 종료·새 요청 거부
  - Vite 8.2.2: 초기 화면, 정적 모듈, 상호작용과 HMR
  - Next.js 16.3.2·React 19.2.8: 임시 비밀번호 변경, RSC, Route Handler, Server Action, client navigation, 상태 보존 Fast Refresh
- `npm run typecheck`, 아키텍처 경계 검사와 `npm run build` 통과
- 이전 npm audit 기록(2026-08-25): 알려진 취약점 0개. 이번 변경 검증에서는 재실행하지 않았다.

PostgreSQL 검증은 [`compose.test.yml`](../compose.test.yml)의 PostgreSQL 17.6과 `npm run test:postgres`로 재현한다. 2026-08-24에 실제 컨테이너에서 계정·opaque Session, 계정 변경과 artifact 발급 경합, 인증 artifact 동시 admission 상한, legacy migration, canary→승인 순서, 재시작 후 admission·kill switch 유지와 실패 시 승인 해제를 통과했다. 실행 순서는 [`linux-deployment.md`](linux-deployment.md)에 고정했다.

2026-09-06에는 CI와 같은 digest로 고정된 PostgreSQL 17.6 컨테이너에서도 `npm run test:postgres` 8개를 모두 통과했다. 새 테스트는 실제 Gateway 프로세스를 실행한 뒤 유휴 DB 연결을 강제로 끊고, 서버 생존·admission 차단·복구·저장된 닫힘 상태 반영을 검사한다. 위 브라우저 테스트는 로컬 HTTP·개발용 쿠키 기준이다.

같은 날 후속 작업으로 Ubuntu·PostgreSQL 17.6·Nginx Proxy Manager·실제 DNS·HTTPS 경로도 검증했다. Gateway 운영 이미지 빌드, public-path canary, canary 기록과 별도 admission 승인, 호스트별 Secure 쿠키, Vite·Next.js 기능, 권한 회수와 Gateway 재시작 뒤 저장 상태 유지가 통과했다. `npm run test:frameworks:public`으로 재실행할 수 있다. 검증한 레코드는 DNS only이며 CDN 프록시는 통과하지 않는다. 공개 기록에서 배포별 식별 정보를 제거했으며 결과와 남은 인수 범위는 [익명 검증 보고서](validation/public-https-2026-09-06.md)에 정리했다.

## 실제 환경에서 남은 인수 작업

다음 항목은 코드만으로 완료할 수 없으며 배포 환경 소유자가 실제 값과 인프라에서 수행해야 한다.

1. 전용 검토 도메인 하나 아래에 콘텐츠 wildcard와 그 바깥의 control host를 배치하고, 승인된 TLS·Ingress 버전과 config digest를 고정한다.
2. secret manager로 active·previous HMAC key와 metrics token을 주입하고 key overlap 회전·철회를 훈련한다.
3. 후보 Ingress의 예약 host에서 public-path canary를 통과하고 결과 기록과 별도 admission 승인을 완료한 뒤에만 사용자 트래픽을 연다.
4. 실제 PostgreSQL 백업을 별도 보안 저장소에 보관하고 격리 DB에 복구한 뒤 로그인·감사·세션 및 operational state를 확인한다.
5. 실제 사용 환경의 macOS arm64·Chrome과 Vite·Next.js 프로젝트 버전을 호환성 매트릭스에 고정한다.
6. 운영 소유자, 알림 임계치, 로그 보존 기간, 회수 전파 SLO와 kill switch 권한자를 배포 환경의 운영 정책으로 확정한다.

이 인수 작업이 끝나기 전 상태는 “코드 완료”이지 “운영 공개 승인”이 아니다.

## 화면 맥락 리뷰 진행 상태

완료한 화면 맥락 리뷰 MVP:

1. stable Project·Review revision과 Tunnel binding
2. 페이지 path 단위 댓글과 격리된 sidebar overlay
3. 인증된 Review API, XSS·CSRF·프로젝트별 데이터 구분와 실 PostgreSQL 검증
4. `REVIEWER`·`DEVELOPER` 답글과 `DEVELOPER` 해결·다시 열기
5. 상태 전이 경합, 해결된 스레드의 답글 거부와 stale authorization 검증
6. 클릭 핀·드래그 영역과 정규화 `REGION_V1` anchor
7. PostgreSQL event log 기반 Review SSE와 replay·보존·연결 제한
8. 댓글·답글 수정·삭제 tombstone과 version 경합
9. 참여자 멘션과 수신자별 내부 알림
10. dev-only Vite·Next.js integration과 해당 모드의 framework E2E
11. 댓글·답글 keyset pagination, 전체 열린 댓글 수와 영속 핀 번호
12. binding lease 만료 회수, SSE burst 병합과 production·tarball 검증

외부 알림, 스크린샷 저장, revision 간 자동 댓글 승계와 전체 편집 이력은 현재 범위에 포함하지 않는다.
