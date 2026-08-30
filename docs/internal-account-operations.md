# 관리자 발급 계정 운영 기준

Review Tunnel의 인증형 Gateway는 외부 IdP 대신 관리자가 직접 발급하는 계정을 사용한다. Linux 서버에는 데스크톱 화면이 필요하지 않다. 최초 관리자는 서버 CLI에서 생성하고, 이후 관리자는 브라우저로 control host의 `/admin/users`에 접속한다.

## 역할

| 역할 | 허용 작업 |
| --- | --- |
| `ADMIN` | 계정 생성, 권한 변경, 비활성화, 비밀번호 초기화, 세션 회수 |
| `DEVELOPER` | Tunnel 생성·재연결·종료 |
| `REVIEWER` | 공유 URL의 로컬 앱 접근 |

한 계정은 여러 역할을 가질 수 있다. 마지막 활성 `ADMIN`은 비활성화하거나 관리자 권한을 제거할 수 없다.

역할은 독립적이다. `ADMIN`이나 `DEVELOPER`만 가진 계정은 공유 화면을 볼 수 없으며 `REVIEWER`를 함께 부여해야 한다. 현재 `REVIEWER` 권한은 배포 전체에 적용된다. 프로젝트별 접근 목록이 없어 다른 활성 공유 주소를 아는 검토자도 접근할 수 있다.

위 표는 `0.1.0`에서 구현된 권한이다. 다음 화면 맥락 리뷰 단계에서는 `REVIEWER`와 `DEVELOPER` 모두 댓글·답글을 작성하고, `DEVELOPER`가 스레드를 해결·다시 열 수 있도록 확장할 예정이다. 아직 구현되지 않은 상세 권한은 [화면 맥락 리뷰 설계](contextual-review.md)를 따른다.

## 최초 설치 흐름

1. PostgreSQL을 준비하고 `DATABASE_URL`을 secret으로 주입한다.
2. DDL 전용 DB role로 `npm run admin -- migrate`를 실행해 스키마를 적용한다. 이 명령에는 `AUTH_SESSION_HMAC_KEY`가 필요하지 않다.
3. 32~128바이트 난수 값을 canonical base64url로 인코딩해 일반 Admin CLI와 Gateway의 `AUTH_SESSION_HMAC_KEY`로 주입한다.
4. DML 전용 일반 Admin CLI role로 `npm run admin -- bootstrap --username admin --display-name "운영 관리자"`를 서버에서 한 번 실행한다. 일반 명령은 migration을 자동 실행하지 않는다.
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
- 계정 정지, 권한 변경, 비밀번호 변경·초기화와 명시적 회수는 `auth_version`을 올리고 기존 로그인 Session·content Session exchange·Carrier credential을 같은 DB transaction에서 폐기한다.
- 로그인 Session·content Session exchange·Carrier credential은 발급 당시 `auth_version`에 묶인다. 발급 저장과 계정 변경이 경합해도 이전 version artifact가 변경 transaction 뒤에 새로 생기지 않도록 계정 row를 잠그고 현재 version을 다시 확인한다.
- 미만료 인증 artifact에는 전역·계정별 DB-atomic 상한이 있다. 여러 Gateway가 동시에 발급해도 PostgreSQL advisory lock 아래에서 정리·개수 확인·삽입을 한 단위로 처리하며, 용량 초과는 명시적인 `AUTH_CAPACITY` 실패로 노출한다.
- 계정 관리·비밀번호·권한·회수와 운영 제어는 PostgreSQL durable audit에 남긴다. 고빈도 로그인 성공·실패는 durable audit 용량을 소진하지 않도록 별도 구조화 보안 로그로 내보내며, 원문 아이디·원격 주소·비밀번호 대신 HMAC 참조와 계정 ID만 기록한다.
- 관리자 웹의 계정 생성·정지·권한·초기화·세션 회수는 현재 관리자 비밀번호를 다시 확인하며 로그인 제한을 동일하게 적용한다. 이 재확인은 불필요한 새 로그인 Session을 발급하지 않고, 대상 변경 transaction 안에서 관리자 계정의 현재 version·역할을 다시 검증한다.
- 관리자는 자신의 비밀번호를 임시 비밀번호 방식으로 초기화할 수 없다. 일회용 비밀번호를 표시하기 전에 본인 Session이 폐기되는 운영 잠금을 막기 위해 `/account/change-password`에서 현재 비밀번호로 직접 변경한다.
- DB 오류가 나면 인증을 우회하지 않고 요청을 거부한다.

## 구현 상태

다음 관리자 발급 계정 기능은 구현과 자동 검증을 마쳤다.

- 중앙 로그인·로그아웃과 최초 비밀번호 변경
- host·audience에 바인딩된 일회용 콘텐츠 세션 교환
- 관리자 웹 UI와 서버 CLI의 생성·권한·정지·초기화·세션 회수
- `DEVELOPER` 로그인 세션을 60초·1회용 Carrier credential로 교환
- 계정·권한·비밀번호 변경을 활성 Tunnel과 진행 중 reviewer Stream에 주기적으로 전파
- 권한 재검증 중 PostgreSQL 오류가 나면 관련 Carrier·Stream을 유지하지 않고 fail-closed 종료
- PostgreSQL migration, 만료 artifact 정리와 Gateway 재시작 뒤 계정·로그인 세션 유지
- PostgreSQL transaction과 advisory lock으로 보장하는 로그인 Session·content exchange·Carrier credential의 계정 version 선형화와 전역·계정별 admission 상한
- 최근 15분 login throttle의 원자적 hard cap과, 계정 변경 flood 뒤에도 kill switch 감사를 남길 수 있는 durable audit 운영 reserve
- Gateway 예약 Cookie·내부 header의 로컬 앱 전달 및 덮어쓰기 차단
- 인증 모드 create 시 Gateway CSPRNG Tunnel ID 발급과 resume purpose 분리
- active·previous HMAC key overlap을 이용한 로그인 세션 무중단 key 검증 전환
- `/admin/operations`의 관리자 재인증 kill switch, PostgreSQL 영속화와 현재 Carrier·Stream·resume 회수
- 배포 identity별 synthetic canary 결과와 별도 admission 승인·폐쇄, Gateway DB 장애 시 신규 활성화 차단
- 별도 bearer로 보호한 `/metrics`와 익명화한 Tunnel 수명주기 로그

## 회수와 kill switch

일반 계정 회수는 `/admin/users`에서 수행한다. 계정 정지, 역할 변경, 비밀번호 초기화와 세션 회수는 `auth_version`을 바꾸고 기본 5초 확인 주기 안에 관련 새 요청과 장기 Stream에 적용된다. 개발자 권한 회수는 소유 Tunnel의 Carrier·모든 Stream·resume을 끝내며, 검토자 회수는 그 검토자의 content session과 Stream만 끝낸다.

`세션 종료`는 현재 로그인 상태를 폐기한다. 해당 사용자가 비밀번호로 새로 로그인하는 것까지 막지는 않는다. 접근을 계속 차단하려면 계정을 정지하거나 해당 역할을 제거한다.

전체 공유를 즉시 중지해야 하면 control host의 `/admin/operations`에서 kill switch를 켠다. 이 동작은 관리자 비밀번호를 다시 확인하고 다음을 수행한다.

- 신규 content 요청과 Carrier 연결 거부
- 현재 Tunnel route를 비활성화하고 모든 Stream·Carrier 종료
- 기존 Resume secret으로 재활성화 금지

kill switch 변경은 PostgreSQL에 감사 이벤트와 함께 저장되고 모든 Gateway가 기본 2초 주기로 반영한다. Gateway 재시작이나 rollback이 이 값을 자동 해제하지 않는다. kill switch를 해제해도 종료된 URL은 되살아나지 않는다. 원인 제거, key·계정 회수, 전용 public-path canary 성공 기록과 해당 배포 admission 재승인을 먼저 완료한 뒤 새 Tunnel만 허용한다.

## Admission 변경

`CANARY_HOST`는 일반 Tunnel과 분리된 synthetic fixture이며 `CANARY_BEARER_TOKEN`으로만 접근한다. 일반 사용자 계정 Cookie나 실제 프로젝트 payload를 쓰지 않는다. canary 성공 후 `record-canary`를 실행해도 공유는 아직 닫혀 있으며, 동일한 `DEPLOYMENT_ID`와 `DEPLOYMENT_CONFIG_DIGEST`에 `approve-admission`을 별도로 실행해야 신규 Session이 활성화된다. 실패 기록은 그 identity의 기존 승인을 지운다.

```bash
npm run admin -- record-canary --as admin --result passed \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
npm run admin -- approve-admission --as admin \
  --deployment-id "$DEPLOYMENT_ID" --config-digest "$DEPLOYMENT_CONFIG_DIGEST"
```

긴급하게 신규 활성화만 막을 때는 `close-admission`, 전체 기존·신규 공유를 끝낼 때는 kill switch를 사용한다. 둘은 목적이 다르며 admission 폐쇄만으로 이미 `ACTIVE`인 Session을 자동 종료하지 않는다.

## HMAC key 회전

`AUTH_SESSION_HMAC_KEY`는 새 artifact를 발급하는 active key다. 회전 rollout 동안 최대 3개의 서로 다른 직전 key를 `AUTH_SESSION_HMAC_KEY_PREVIOUS`에 넣으면 기존 opaque 로그인 Session·일회용 artifact를 bounded 후보 key로 조회할 수 있다. active key를 previous 목록에 중복해서 넣을 수 없다. overlap은 로그인 Session 최대 12시간과 시계 오차를 넘긴 뒤 제거한다. Gateway 재시작은 메모리 Tunnel Registry를 잃으므로 maintenance 공지와 함께 수행한다.

## 운영 책임 경계

실제 공개 운영에는 DNS·TLS·Ingress, secret manager, PostgreSQL 백업·복구 drill, public-path canary와 파일럿 부하 검증이 별도로 필요하다. 구체적인 순서와 환경 변수는 [`linux-deployment.md`](linux-deployment.md)를 따른다. 로그 보존 기간, 운영 소유자, 알림 임계치와 revocation propagation SLO는 각 배포 환경의 운영 정책으로 확정한다.
