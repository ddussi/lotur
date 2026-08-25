# ADR-0001: TypeScript와 Node.js 24를 초기 런타임으로 사용

- 상태: 승인
- 날짜: 2026-08-21

## 결정

Gateway와 Tunnel Client의 Phase 0·1 구현은 TypeScript와 Node.js 24를 사용한다.

Gateway는 클라우드나 자체 Linux 서버에서 동일한 컨테이너 이미지로 실행한다. 버전 `0.1.0`의 Client는 저장소를 clone한 뒤 npm script로 실행한다. npm 패키지와 OS별 단일 실행 파일은 별도 패키징 단계에서 검토한다.

## 이유

- Gateway와 Client가 protocol type과 contract test를 공유할 수 있다.
- Node.js Stream과 Socket은 HTTP body, SSE와 upgrade 이후 byte stream을 전체 buffering 없이 전달할 수 있다.
- 현재 개발 환경에 Node.js 24와 TypeScript 5.9가 준비되어 있어 POC 시작 비용이 작다.
- 이 제품의 핵심은 CPU 연산이 아니라 bounded queue, backpressure, cancellation과 상태 전이의 정확성이다.

## 제약

- 느린 consumer가 전체 Carrier를 막지 않도록 Stream별·Carrier별 buffer 상한을 둔다.
- 앱 payload를 JSON이나 문자열로 변환하지 않고 `Uint8Array`로 전달한다.
- Relay Core는 Node.js HTTP framework나 AWS SDK에 의존하지 않는다.
- 성능 또는 메모리 목표를 충족하지 못하면 protocol contract를 유지한 채 전송 adapter나 런타임 교체를 검토한다.
