# ADR-0003: 관리자 발급 계정 인증

- 상태: Accepted
- 날짜: 2026-08-21

## 배경

초기 기획은 외부 OIDC 제공자를 전제로 했지만 제품 소유자는 외부 IdP 없이 관리자가 사용자를 지정해 생성하는 방식을 선택했다. Gateway는 클라우드 또는 화면 없는 Linux 서버에서 실행할 수 있으며, 최초 관리자 생성과 장애 복구에는 브라우저 외 관리 경로도 필요하다.

## 결정

- 공개 회원가입을 제공하지 않고 최초 `ADMIN`은 PostgreSQL advisory lock을 사용하는 서버 CLI bootstrap으로 한 번만 생성한다.
- 이후 계정 관리는 관리자 웹 UI와 관리자 비밀번호를 다시 확인하는 CLI에서 수행한다.
- 역할은 `ADMIN`, `DEVELOPER`, `REVIEWER`이며 한 계정이 여러 역할을 가질 수 있다.
- 비밀번호는 Argon2id로 해시하고 일회용 임시 비밀번호는 최초 로그인 때 변경한다.
- 계정, 역할, 로그인 제한, opaque 세션 HMAC, 일회용 host 교환, Carrier credential과 관리자·운영 감사 이벤트는 PostgreSQL에 저장한다. 고빈도 로그인 성공·실패는 HMAC 참조만 담은 별도 구조화 보안 로그로 보낸다.
- control 세션과 콘텐츠 세션은 audience를 분리한다. 콘텐츠 세션은 개별 Tunnel authority에 바인딩된 1회용 코드로 교환한다.
- `DEVELOPER` 로그인 세션은 60초·1회용·purpose·Tunnel 제한 Carrier credential로 교환한다. 로그인 세션이나 비밀번호를 WSS에 보내지 않는다.
- 계정 `auth_version` 변경은 기존 세션을 무효화하고 Gateway의 주기 검증이 활성 Tunnel과 reviewer Stream을 종료한다.
- Relay Core는 계정·비밀번호·PostgreSQL을 알지 않는다. 인증 코어는 저장소 포트에만 의존하고 PostgreSQL과 HTTP/UI는 adapter로 둔다.

## 결과

외부 IdP 설정과 장애 의존성은 사라지지만 비밀번호 보호, 계정 복구, 로그인 제한, 감사, DB 백업과 secret 회전은 Review Tunnel 운영 책임이 된다. 이메일 기반 자동 복구는 MVP에서 제공하지 않으며 관리자가 임시 비밀번호로 초기화한다.

Gateway 재시작 때 Tunnel URL이 끝나는 기존 결정은 유지하지만 관리자 발급 계정과 로그인 세션은 PostgreSQL에 남는다. HMAC key 회전 시 기존 active key를 제한된 기간 `AUTH_SESSION_HMAC_KEY_PREVIOUS`에 두면 기존 로그인·일회용 자격증명을 계속 검증할 수 있다. overlap 없이 key를 교체하면 기존 자격증명은 무효화된다.
