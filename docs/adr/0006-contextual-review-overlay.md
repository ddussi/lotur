# ADR-0006: 화면 맥락 리뷰를 선택적 오버레이와 Gateway 예약 API로 제공

- 상태: 제안
- 날짜: 2026-08-31

## 배경

Review Tunnel의 현재 구현은 인증된 검토자에게 로컬 웹앱의 HTTP, streaming/SSE와 WebSocket 동작을 중계한다. 제품을 범용 터널과 구분하려면 페이지 또는 특정 영역에 댓글을 남기고 해결하는 리뷰 흐름이 필요하다.

오버레이를 표시하기 위해 Gateway가 모든 HTML 응답을 자동 변환하면 압축, `Content-Length`, CSP, streaming HTML, Next.js RSC와 개발 서버 HMR에 영향을 줄 수 있다. 브라우저 확장은 검토자에게 별도 설치를 요구한다.

댓글을 Tunnel ID에 직접 귀속하면 Client 재실행이나 Gateway 재시작으로 URL이 바뀔 때 리뷰 기록을 잃는다. 또한 댓글 메시지를 Carrier protocol에 포함하면 앱 트래픽 중계와 제품 데이터의 수명주기가 결합된다.

## 제안 결정

1. 리뷰 UI는 Client의 review 모드에서 명시적으로 활성화하는 개발 서버 integration이 bootstrap하는 선택적 오버레이로 제공한다.
2. 오버레이는 Shadow DOM을 사용해 검토 대상 앱의 CSS·DOM과 격리한다.
3. Gateway는 콘텐츠 host의 `/_review-tunnel/review/*` 예약 경로에서 asset, 인증된 Review API와 실시간 이벤트를 직접 제공한다. 이 요청은 로컬 앱으로 전달하지 않는다.
4. 댓글과 답글은 PostgreSQL에 저장하고 stable Project 및 review revision에 귀속한다. Tunnel은 현재 revision을 노출하는 임시 binding만 가진다.
5. 첫 리뷰 MVP는 page anchor와 비율 좌표 region anchor를 지원한다. 안정적인 `data-review-id` 요소 anchor는 후속 확장으로 둔다.
6. 리뷰 데이터는 기존 `review-tunnel.v1` Carrier 메시지에 넣지 않는다.
7. HTML 응답 자동 rewrite와 브라우저 확장은 기본 전달 방식으로 사용하지 않는다.

세부 제품 범위와 보안 정책은 [`../contextual-review.md`](../contextual-review.md)를 따른다.

## 결과

- 검토자는 별도 설치 없이 공유 화면에서 리뷰할 수 있다.
- 앱 중계 계층의 의미 투명성과 리뷰 데이터 저장 수명주기를 분리할 수 있다.
- Vite, Next.js와 generic 앱마다 얇은 integration을 유지해야 한다.
- strict CSP를 포함한 프레임워크별 호환성 검증이 필요하다.
- 좌표 anchor는 레이아웃이 크게 바뀌면 부정확할 수 있으므로 불확실 상태와 fallback UX가 필요하다.

## 재검토 조건

- 지원 대상 프레임워크 대부분에서 integration 유지 비용이 HTML rewrite 위험보다 커지는 경우
- 브라우저가 표준화된 annotation API를 제공해 별도 오버레이 injection이 불필요해지는 경우
- 파일럿에서 설치형 브라우저 도구가 허용되고 더 강한 DOM 접근이 필수로 확인되는 경우
