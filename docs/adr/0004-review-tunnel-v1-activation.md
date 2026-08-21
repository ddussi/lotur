# ADR-0004: activation barrier를 포함한 Review Tunnel v1

- 상태: 승인
- 날짜: 2026-08-24
- 대체 대상: ADR-0002의 POC profile과 승격 조건

## 결정

Client–Gateway Carrier는 WebSocket subprotocol `review-tunnel.v1`만 수용한다. 인증 모드의 create Tunnel ID와 공유 URL은 Gateway가 CSPRNG로 발급한다.

새 Session은 다음 순서를 모두 통과하기 전에는 외부 route를 열지 않는다.

1. `HELLO`의 credential purpose, local-origin fingerprint와 Origin projection 검증
2. `SESSION_PROVISIONED`의 provision receipt와 Resume secret 수신
3. revision과 canonical SHA-256 digest가 있는 불변 `SESSION_CONFIG` 적용
4. 정확한 generation·revision·digest·receipt를 돌려주는 `CONFIG_APPLIED`
5. initial origin 점검과 flow-controlled 양방향 Relay nonce probe
6. Gateway admission 확인과 route 승격
7. `SESSION_ACTIVE`를 앱 `OPEN_HTTP`보다 먼저 전송

resume은 같은 개발자, Resume secret, local-origin fingerprint와 projection을 요구하고 새 generation·revision에서 위 활성화 절차를 다시 수행한다. 한 Session에는 후보 generation 하나만 허용하며 일시적 경합만 bounded retry 대상으로 삼는다.

## 수명과 실패

- current generation은 heartbeat PING/PONG으로 Carrier lease를 유지한다.
- 최대 수명, 유휴 수명, 재연결 유예와 authorization max-age가 각각 route·Carrier·Stream을 종료한다.
- stale generation과 protocol·flow-control 위반은 fail-closed한다.
- 활성화 전 create 실패는 provisional route와 Resume secret을 폐기한다.
- 이미 닫힌 Stream에 네트워크 순서상 늦게 도착한 `WINDOW_UPDATE`만 멱등 no-op으로 처리한다.
- 명시적 종료와 운영 kill switch는 route를 먼저 닫고 열린 Stream·Carrier·resume 권한을 회수한다.

## 프록시 경계

Client는 loopback만 허용한다. `localhost`는 모든 DNS 결과가 loopback인지 확인한 뒤 실제 연결 가능한 IP literal을 Session 동안 고정한다. Gateway 자격 증명과 forwarding header는 앱에 전달하지 않으며 Origin projection, Location·Refresh와 Cookie 변환은 서명된 Session configuration을 따른다. CONNECT와 WebSocket 이외 Upgrade는 v1 범위 밖으로 명시적으로 거부한다.

## 결과

Carrier 연결 성공과 공유 가능 상태를 구분할 수 있고, 설정 불일치나 부분 장애가 있는 URL을 노출하지 않는다. 대신 activation·resume 상태기계와 운영 canary가 필수 계약이 되며, 실제 TLS·Ingress admission은 배포 환경에서 별도로 검증해야 한다.
