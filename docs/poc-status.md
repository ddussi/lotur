# Review Tunnel 보안 MVP 구현 상태

- 상태: Phase 2 애플리케이션 구현 완료, 환경별 운영 인수 대기
- 기준일: 2026-08-25
- 제품 방향 갱신: 2026-08-31
- 런타임: TypeScript 5.9, Node.js 24
- Carrier profile: `review-tunnel.v1`

> [!NOTE]
> 이 문서는 `0.1.0`의 안전한 공유 기반 구현 상태를 기록한다. 제품은 페이지·영역 댓글과 해결 흐름을 제공하는 리뷰 도구로 확장하기로 했으며, 해당 기능은 아직 구현되지 않았다. 다음 단계의 범위는 [화면 맥락 리뷰 설계](contextual-review.md)를 따른다.

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

## 자동 검증 결과

2026-08-25 기준 자동 검증 항목은 다음과 같다. 정확한 테스트 수는 현재 `npm run check:mvp` 출력으로 확인한다.

- `npm test`: 전체 단위·통합 테스트 통과. PostgreSQL 실연동 항목은 `TEST_DATABASE_URL`이 없을 때만 명시적으로 건너뛰며 CI 완료 게이트에서는 실제 DB로 모두 실행
- `npm run test:frameworks`: 2개 통과
  - Vite 8.2.2 인증형 Gateway: 초기 화면, 정적 모듈, 상호작용과 HMR
  - Next.js 16.3.2·React 19.2.8: RSC, Route Handler, Server Action, client navigation, 상태 보존 Fast Refresh
- `npm run typecheck`, 아키텍처 경계 검사와 `npm run build` 통과
- npm audit: 알려진 취약점 0개

PostgreSQL 검증은 [`compose.test.yml`](../compose.test.yml)의 PostgreSQL 17.6과 `npm run test:postgres`로 재현한다. 2026-08-24에 실제 컨테이너에서 계정·opaque Session, 계정 변경과 artifact 발급 경합, 인증 artifact 동시 admission 상한, legacy migration, canary→승인 순서, 재시작 후 admission·kill switch 유지와 실패 시 승인 해제를 통과했다. 실행 순서는 [`linux-deployment.md`](linux-deployment.md)에 고정했다.

## 실제 환경에서 남은 인수 작업

다음 항목은 코드만으로 완료할 수 없으며 배포 환경 소유자가 실제 값과 인프라에서 수행해야 한다.

1. 전용 검토 도메인 하나 아래에 콘텐츠 wildcard와 그 바깥의 control host를 배치하고, 승인된 TLS·Ingress 버전과 config digest를 고정한다.
2. secret manager로 active·previous HMAC key와 metrics token을 주입하고 key overlap 회전·철회를 훈련한다.
3. 후보 Ingress의 예약 host에서 public-path canary를 통과하고 결과 기록과 별도 admission 승인을 완료한 뒤에만 사용자 트래픽을 연다.
4. 실제 PostgreSQL 백업을 별도 보안 저장소에 보관하고 격리 DB에 복구한 뒤 로그인·감사·세션 및 operational state를 확인한다.
5. 실제 사용 환경의 macOS arm64·Chrome과 Vite·Next.js 프로젝트 버전을 호환성 매트릭스에 고정한다.
6. 운영 소유자, 알림 임계치, 로그 보존 기간, 회수 전파 SLO와 kill switch 권한자를 배포 환경의 운영 정책으로 확정한다.

이 인수 작업이 끝나기 전 상태는 “코드 완료”이지 “운영 공개 승인”이 아니다.

## 다음 제품 단계: 화면 맥락 리뷰

공유 기반 위에 다음 기능을 순서대로 추가한다.

1. stable Project·Review revision과 Tunnel binding
2. 페이지 path 단위 댓글과 격리된 sidebar overlay
3. 클릭 위치 영역 핀, 답글과 해결·다시 열기
4. 인증된 Review API와 SSE 실시간 갱신
5. Vite·Next.js integration 호환성 및 XSS·CSRF·프로젝트 격리 검증

이 목록은 로드맵이며 위의 “완료한 애플리케이션 범위”에 포함되지 않는다.
