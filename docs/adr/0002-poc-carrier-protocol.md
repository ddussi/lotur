# ADR-0002: 격리 POC Carrier protocol을 정식 v1과 분리

- 상태: 승인
- 날짜: 2026-08-21

## 결정

Phase 1 격리 POC는 WebSocket subprotocol `review-tunnel.poc.1`을 사용한다. 보안 포함 MVP의 `review-tunnel.v1`은 인증, provisioning, configuration ACK, probe, heartbeat와 resume 계약까지 구현·검증된 뒤에만 사용한다.

POC envelope는 WebSocket binary message 하나에 다음 16-byte header와 payload 하나를 담는다.

| Offset | 크기 | 값 |
| --- | ---: | --- |
| 0 | 2 | ASCII `RT` magic |
| 2 | 1 | envelope version |
| 3 | 1 | frame type |
| 4 | 1 | flags |
| 5 | 1 | reserved, 0 |
| 6 | 4 | generation, big-endian uint32 |
| 10 | 4 | stream ID, big-endian uint32 |
| 14 | 2 | payload 길이, big-endian uint16 |

metadata는 크기가 제한된 UTF-8 JSON object로, 앱 body와 raw WebSocket byte는 `DATA`의 binary payload로 전달한다. DATA는 최대 32 KiB로 자르고 전체 Carrier pending write는 1 MiB를 넘기지 않는다.

방향별 송신은 Stream 초기 64 KiB, Carrier 전체 256 KiB credit을 사용한다. downstream write에 성공적으로 인계한 byte만 같은 Stream의 `WINDOW_UPDATE`로 반환한다. reset된 Stream의 미반환 connection credit은 회수한다.

POC create는 32-byte Resume secret을 Client에 전달하고 Gateway에는 프로세스별 HMAC-SHA-256 digest만 둔다. transport 단절 뒤 2분 안의 올바른 secret만 같은 Tunnel ID를 다음 generation으로 복구한다. 명시적 `CLOSE_SESSION`은 URL과 secret을 즉시 폐기한다. 정식 v1의 provisional receipt·configuration ACK·candidate CAS를 대체하는 계약은 아니며, 현재 Client library가 resume 입력을 지원하되 CLI 자동 retry loop는 Phase 2 범위다.

## 정식 v1 승격 조건

- Carrier credential과 subprotocol 검증
- `SESSION_PROVISIONED`, immutable config revision·digest, `CONFIG_APPLIED`
- initial origin·Relay probe와 activation barrier
- heartbeat, lease와 실제 reconnect/resume generation fencing
- 안정적인 connection·stream error code
- Stream·connection queue와 공정성 부하 테스트

이 조건을 채우기 전에는 profile 이름만 `review-tunnel.v1`로 바꾸지 않는다.
