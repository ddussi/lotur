# 내부 계정 운영 기준

Review Tunnel은 외부 IdP 대신 관리자가 발급하는 내부 계정을 사용한다. Linux 서버에는 데스크톱 화면이 필요하지 않다. 최초 관리자는 서버 CLI에서 생성하고, 이후 관리자는 자신의 PC 브라우저로 control host의 `/admin/users`에 접속한다.

## 역할

| 역할 | 허용 작업 |
| --- | --- |
| `ADMIN` | 계정 생성, 권한 변경, 비활성화, 비밀번호 초기화, 세션 회수 |
| `DEVELOPER` | Tunnel 생성·재연결·종료 |
| `REVIEWER` | 공유 URL의 로컬 앱 접근 |

한 계정은 여러 역할을 가질 수 있다. 마지막 활성 `ADMIN`은 비활성화하거나 관리자 권한을 제거할 수 없다.

## 최초 설치 흐름

1. PostgreSQL을 준비하고 `DATABASE_URL`을 secret으로 주입한다.
2. 32바이트 이상의 난수 값을 base64url로 인코딩해 `AUTH_SESSION_HMAC_KEY`로 주입한다.
3. `npm run admin -- migrate`로 스키마를 적용한다.
4. `npm run admin -- bootstrap --username admin --display-name "운영 관리자"`를 서버에서 한 번 실행한다.
5. 한 번만 출력되는 임시 비밀번호를 안전한 경로로 전달한다.
6. 관리자는 `npm run admin -- change-password --username admin`으로 임시 비밀번호를 변경한다.
7. 이후 브라우저 관리자 UI 또는 인증된 CLI를 사용한다.

자동화에서 비밀번호를 입력해야 할 때만 `--password-stdin`을 명시한다. 비밀번호를 명령행 인자나 환경 변수에 넣지 않는다. `--password-stdin` 입력은 필요한 줄 수와 정확히 일치해야 한다.

## 보안 불변식

- 비밀번호는 Argon2id 해시로만 저장한다. 현재 파라미터는 19 MiB, 반복 2, 병렬도 1이다.
- 사용자 비밀번호는 15~128자이며 붙여넣기와 비밀번호 관리자를 허용한다.
- 임시 비밀번호는 생성·초기화 응답에서 한 번만 표시하고 DB나 로그에 평문으로 저장하지 않는다.
- 로그인 실패는 아이디와 원격 주소 조합으로 제한하며 계정 존재 여부가 다른 오류로 드러나지 않게 한다.
- 세션 원문은 저장하지 않고 HMAC-SHA-256 lookup 값만 저장한다.
- 계정 정지, 권한 변경, 비밀번호 변경·초기화는 기존 로그인 세션을 폐기한다.
- 계정 관리 동작과 로그인 성공·실패는 payload나 비밀번호 없이 감사 이벤트로 남긴다.
- 관리자 웹의 계정 생성·정지·권한·초기화·세션 회수는 현재 관리자 비밀번호를 다시 확인하며 로그인 제한을 동일하게 적용한다.
- DB 오류가 나면 인증을 우회하지 않고 요청을 거부한다.

## 구현 상태

다음 내부 계정 기능은 구현과 자동 검증을 마쳤다.

- 중앙 로그인·로그아웃과 최초 비밀번호 변경
- host·audience에 바인딩된 일회용 콘텐츠 세션 교환
- 관리자 웹 UI와 서버 CLI의 생성·권한·정지·초기화·세션 회수
- `DEVELOPER` 로그인 세션을 60초·1회용 Carrier credential로 교환
- 계정·권한·비밀번호 변경을 활성 Tunnel과 진행 중 reviewer Stream에 주기적으로 전파
- PostgreSQL migration, 만료 artifact 정리와 Gateway 재시작 뒤 계정·로그인 세션 유지
- Gateway 예약 Cookie·내부 header의 로컬 앱 전달 및 덮어쓰기 차단
- 인증 모드 create 시 Gateway CSPRNG Tunnel ID 발급과 resume purpose 분리
- active·previous HMAC key overlap을 이용한 로그인 세션 무중단 key 검증 전환
- `/admin/operations`의 관리자 재인증 kill switch와 현재 Carrier·Stream·resume 회수
- 별도 bearer로 보호한 `/metrics`와 익명화한 Tunnel 수명주기 로그

## 회수와 kill switch

일반 계정 회수는 `/admin/users`에서 수행한다. 계정 정지, 역할 변경, 비밀번호 초기화와 세션 회수는 `auth_version`을 바꾸고 기본 5초 확인 주기 안에 관련 새 요청과 장기 Stream에 적용된다. 개발자 권한 회수는 소유 Tunnel의 Carrier·모든 Stream·resume을 끝내며, 검토자 회수는 그 검토자의 content session과 Stream만 끝낸다.

전체 공유를 즉시 중지해야 하면 control host의 `/admin/operations`에서 kill switch를 켠다. 이 동작은 관리자 비밀번호를 다시 확인하고 다음을 수행한다.

- 신규 content 요청과 Carrier 연결 거부
- 현재 Tunnel route를 비활성화하고 모든 Stream·Carrier 종료
- 기존 Resume secret으로 재활성화 금지

kill switch를 해제해도 종료된 URL은 되살아나지 않는다. 원인 제거, key·계정 회수와 public-path canary를 먼저 완료한 뒤 새 Tunnel만 허용한다.

## HMAC key 회전

`AUTH_SESSION_HMAC_KEY`는 새 artifact를 발급하는 active key다. 회전 rollout 동안 직전 key를 `AUTH_SESSION_HMAC_KEY_PREVIOUS`에 넣으면 기존 opaque 로그인 세션·일회용 artifact를 후보 key로 조회할 수 있다. overlap은 로그인 세션 최대 12시간과 시계 오차를 넘긴 뒤 제거한다. Gateway 재시작은 메모리 Tunnel Registry를 잃으므로 maintenance 공지와 함께 수행한다.

## 운영 책임 경계

실제 공개 운영에는 DNS·TLS·Ingress, secret manager, PostgreSQL 백업·복구 drill, public-path canary와 파일럿 부하 검증이 별도로 필요하다. 구체적인 순서와 환경 변수는 [`linux-deployment.md`](linux-deployment.md)를 따른다. 로그 보존 기간, 운영 소유자, 알림 임계치와 revocation propagation SLO는 회사 정책으로 승인하기 전까지 미확정이다.
