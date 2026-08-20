# Review Tunnel Phase 0·1 및 내부 계정 인증 구현 결과

- 상태: 격리 POC 핵심 경로 완료
- 기준일: 2026-08-21
- 런타임: TypeScript 5.9, Node.js 24
- Carrier profile: `review-tunnel.poc.1`

## 내부 계정 인증 완료 범위

- 공개 회원가입 없는 `ADMIN`·`DEVELOPER`·`REVIEWER` 내부 계정
- Linux CLI 최초 관리자 bootstrap과 관리자 CLI 전체 계정 작업
- Argon2id 비밀번호 해시, 최초 변경 임시 비밀번호와 계정 단위 로그인 제한
- PostgreSQL 계정·세션·로그인 제한·일회용 교환·Carrier credential·감사 이벤트 저장
- 중앙 로그인/로그아웃, host 전용 세션 교환과 관리자 웹 UI
- Client 로그인 API와 60초·1회용·purpose/Tunnel 제한 Carrier credential
- 계정 정지·권한·비밀번호 변경 시 로그인 세션 폐기와 활성 Tunnel·Stream 회수
- control/content session audience 분리와 Gateway 예약 Cookie 격리
- eTLD+1 기준 content/control 사이트 경계 검증
- Linux multi-stage Docker 이미지와 headless 운영 절차

## 완료한 범위

- npm workspace와 Gateway·Client·protocol·proxy·relay 경계
- 실행 가능한 loopback Gateway와 Client CLI
- 16-byte binary envelope와 binary-safe DATA chunk
- 일반 HTTP method, path·query, 반복 header와 request·response body streaming
- SSE 첫 chunk 즉시 flush와 downstream cancellation 전파
- 로컬 101 성공 뒤 WebSocket raw byte 중계
- WebSocket binary message, subprotocol과 정상 close E2E
- Stream 64 KiB, Carrier 256 KiB flow-control credit
- DATA 32 KiB chunk와 Carrier pending write 1 MiB 상한
- 1 MiB가 넘는 payload의 window 정지·갱신·재개 E2E
- create 시 Resume secret 발급, Gateway HMAC 저장, 2분 안의 동일 URL resume와 generation 증가
- 잘못된 Resume secret 거부와 명시적 종료 시 URL·secret 즉시 폐기
- 최대 8시간, Stream이 없을 때 idle 30분, reconnect 2분의 순수 Session 상태기계
- hop-by-hop header와 `Connection`이 지목한 동적 header 제거
- metadata CR/LF injection, 잘못된 frame·version·길이의 fail-closed 검증
- TypeScript typecheck, 아키텍처 경계 검사, JavaScript emit build와 loopback E2E

## 검증 결과

`npm run check`가 다음을 한 번에 검증한다.

1. TypeScript strict typecheck
2. protocol·relay·proxy 패키지의 앱 역의존 금지
3. `dist/` JavaScript emit build
4. 단위·통합·loopback E2E 62개. PostgreSQL 통합 테스트는 `TEST_DATABASE_URL`이 있을 때 실행

추가 검증에서 실제 PostgreSQL 17 컨테이너의 migration·Argon2id·재시작 세션 영속성이 통과했다. Linux multi-stage 이미지를 빌드하고 이미지 내부에서 Argon2id 네이티브 모듈과 production 도메인 설정 검증을 실행했다. npm 운영 의존성 audit 결과는 알려진 취약점 0건이다.

## 현재 안전 경계

환경 변수 없이 실행하는 기본 모드는 인증과 TLS가 없는 격리 POC다. Gateway는 기본적으로 `127.0.0.1`에만 바인딩하며 외부 bind는 명시적 `ALLOW_INSECURE_POC=true` 없이는 거부한다. 내부 계정 모드는 `DATABASE_URL`, `CONTROL_HOST`, `AUTH_SESSION_HMAC_KEY`를 모두 제공해야 활성화된다.

정식 `review-tunnel.v1`이나 실제 사내 운영으로 간주하지 않는다. 다음 항목은 Phase 2에서 구현·검증해야 한다.

- `SESSION_PROVISIONED`, configuration revision·digest·ACK와 activation probe
- heartbeat, lease와 CLI 자동 reconnect retry loop
- 실제 Gateway에 8시간·30분 Session timer와 authorization max-age 적용
- content·auth·control 사이트 경계, TLS·Ingress와 public-path canary
- Origin projection, Gateway cookie·credential 격리와 Location·Cookie 정책
- 유형별 timeout·rate·동시성·request/response 크기 제한
- 로그·메트릭·회수 SLO와 운영 kill switch
- 실제 TLS·Ingress, secret manager, PostgreSQL 백업·복구와 public-path canary

Phase 2 인수 기준을 통과하기 전에는 인터넷이나 사내 일반 사용자에게 공개하지 않는다.
