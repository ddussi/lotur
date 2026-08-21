# Review Tunnel 보안 MVP 구현 상태

- 상태: Phase 2 애플리케이션 구현 완료, 환경별 운영 인수 대기
- 기준일: 2026-08-24
- 런타임: TypeScript 5.9, Node.js 24
- Carrier profile: `review-tunnel.v1`

## 완료한 애플리케이션 범위

- Gateway가 발급하는 인증 모드 Tunnel ID·공유 URL과 `SESSION_PROVISIONED → SESSION_CONFIG → CONFIG_APPLIED → OPEN_PROBE → SESSION_ACTIVE` 활성화 장벽
- configuration revision·canonical digest·provision receipt 검증, 동일 ACK 멱등 처리, 1회 재전송과 activation timeout
- generation fencing, heartbeat·lease, 8시간 최대 수명·30분 유휴·2분 resume 유예와 CLI bounded exponential reconnect
- `localhost`의 모든 DNS 결과 loopback 검증, 연결 가능한 IP literal 고정과 resume 시 local-origin fingerprint 고정
- 일반 HTTP body streaming, SSE, WebSocket raw byte relay와 Stream·Carrier flow control
- 닫힌 Stream에 늦게 도착한 flow-control 갱신의 안전한 무시와 Gateway 종료 시 Upgrade socket 회수
- `local-view`·`proxy-aware` Origin projection, untrusted forwarding header 제거, Host·Origin·Referer 재구성
- 로컬 절대 `Location`·`Refresh`의 public origin 변환과 `Set-Cookie` Domain·예약 Cookie 격리
- WebSocket `Sec-WebSocket-Accept` 검증, generic CONNECT와 WebSocket 이외 Upgrade 명시적 거부
- request body·finite response 크기, 응답 header·inactivity·최대 지속 시간, 동시 Stream·분당 새 Stream 제한
- 내부 계정, host별 content session, 60초·1회용·purpose 제한 Carrier credential과 HMAC key overlap 회전
- 인증 정책을 Tunnel 조회보다 먼저 적용해 미인증 사용자에게 Tunnel 존재 여부를 노출하지 않는 경계
- 개발자·검토자 authorization max-age와 `auth_version` 회수, 현재 Stream·Carrier·resume 폐기
- HMAC 익명 Tunnel reference를 쓰는 구조화 수명주기 로그, low-cardinality Prometheus 메트릭과 별도 bearer 보호
- 관리자 재인증이 필요한 운영 kill switch와 초기 환경 admission gate
- PostgreSQL custom-format 원자 백업 및 확인 문자열이 필요한 파괴적 복구 스크립트
- 미인증 차단·request streaming·SSE·WebSocket을 검사하는 고정 public-path canary

## 자동 검증 결과

2026-08-24 로컬 검증 결과는 다음과 같다.

- `npm test`: 87개 중 86개 통과, 실패 0, PostgreSQL 실연동 1개는 `TEST_DATABASE_URL`이 없어 건너뜀
- `npm run test:frameworks`: 2개 통과
  - Vite 8.2.2: 초기 화면, 정적 모듈, 상호작용과 HMR
  - Next.js 16.3.2·React 19.2.8: RSC, Route Handler, Server Action, client navigation, 상태 보존 Fast Refresh
- `npm run typecheck`, 아키텍처 경계 검사와 `npm run build` 통과
- npm audit: 알려진 취약점 0개

PostgreSQL 검증은 [`compose.test.yml`](../compose.test.yml)의 PostgreSQL 17.6과 `npm run test:postgres`로 재현한다. 이번 작업 환경에서는 Docker daemon이 실행 중이지 않아 실연동 테스트를 다시 실행하지 못했다. 실행 순서는 [`linux-deployment.md`](linux-deployment.md)에 고정했다.

## 실제 환경에서 남은 인수 작업

다음 항목은 코드만으로 완료할 수 없으며 배포 환경 소유자가 실제 값과 인프라에서 수행해야 한다.

1. 콘텐츠 wildcard와 control host를 서로 다른 사이트 경계에 배치하고 승인된 TLS·Ingress 버전과 config digest를 고정한다.
2. secret manager로 active·previous HMAC key와 metrics token을 주입하고 key overlap 회전·철회를 훈련한다.
3. 후보 Ingress에서 public-path canary를 통과한 뒤에만 신규 Session admission과 사용자 트래픽을 연다.
4. 실제 PostgreSQL 백업을 별도 보안 저장소에 보관하고 격리 DB에 복구한 뒤 로그인·감사·세션 스키마를 확인한다.
5. 관리되는 macOS arm64·Chrome과 회사 표준 Vite·Next.js 프로젝트 버전을 호환성 매트릭스에 고정한다.
6. 운영 소유자, 알림 임계치, 로그 보존 기간, 회수 전파 SLO와 kill switch 권한자를 조직 정책으로 승인한다.

이 인수 작업이 끝나기 전 상태는 “코드 완료”이지 “운영 공개 승인”이 아니다.
