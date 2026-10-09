# Review Tunnel 업데이트 순서와 완료 조건

현재 알파의 핵심 흐름을 유지하면서, 확인된 문제부터 작은 변경으로 해결한다. 아래는 제안된 작업 순서다. 일정·담당자·GitHub 이슈 생성·릴리스 승인은 확정하지 않았다. 기준 SHA와 발견 근거는 [분석 보고서](report.md), 수행한 검사는 [검증 기록](validation.md)에 있다.

## 1단계 현재 기준을 다시 통과시키기

### U1 의존성 보안 수정과 통합 지원 기준 갱신

- 범위: root manifest/lock, Next integration의 peer 지원 하한, 관련 설치·호환 문서와 고정값 검사. 운영 lock은 해당 의존성이 없으므로 무관한 변경을 섞지 않는다.
- 순서: 오늘의 감사 결과를 기준으로 목표 버전을 선택한다. Next 16.3.8 이상 검증된 16.x, sharp 0.35.5 이상, source-map-js 1.2.2 이상이 실제 해석되는지 확인한다. 루트 설치와 패키징 소비자 경로를 모두 대조한다.
- 완료 조건: root와 runtime의 감사 결과가 각각 기록되고, 기존 권고가 해결됐거나 적용 제외의 근거가 명시된다. Next peer·README·fixture 버전 설명이 일치한다. CI에서 감사 단계를 삭제하거나 실패를 무시하지 않는다.
- 검증: `npm ci`, root 및 `--prefix deploy/runtime` 감사, `npm run check:mvp`, integration tarball 소비자, Next production bootstrap 비활성화. runtime 이미지 구성이나 build 도구가 달라졌으면 기존 이미지·demo·restore 검사도 수행한다.
- 위험과 비용: 패치 변경도 개발 서버·브라우저 동작을 바꿀 수 있다. 도구 전체 업그레이드와 한 변경에 묶지 않는다. 소비자의 최소 지원 버전 변경을 릴리스 안내에 적는다.

### U2 목록 필터와 더 보기 경합 수정

- 범위: Control 프로젝트 댓글 목록의 cursor·요청 세대·더 보기 상태. 서버의 cursor scope 검사는 유지한다.
- 먼저 실패할 검사: 첫 페이지 응답을 늦춘 상태의 필터 변경 후 더 보기, 더 보기 도중 다른 필터로 변경, 응답과 오류 역순 도착.
- 최소 구현: 필터 변경 즉시 이전 cursor 무효화, 첫 페이지 완료 전 더 보기 금지, 현재 조회에 속한 응답·오류만 화면에 적용.
- 완료 조건: 표시 필터와 행이 항상 일치한다. 다른 필터의 cursor 요청이 발생하지 않는다. 오래된 실패가 최신 성공 화면을 덮지 않는다. 기존 순차 페이지 동작은 유지된다.
- 검증: 실제 Control 화면의 지연 응답 브라우저 회귀, UI 생성물 검사, 관련 타입·빌드·일반 테스트.
- 위험과 비용: 공용 상태 관리 도구는 필요 없다. 제어 화면의 국소 변경으로 처리한다.

### U3 트랜잭션 오류 계약 정리

- 범위: 공통 `withTransaction`과 첫 관리자 생성의 중복 트랜잭션 종료 경로.
- 먼저 실패할 검사: work 또는 COMMIT 실패 후 ROLLBACK 실패, BEGIN 실패, 정상 rollback. 두 오류의 식별 가능성과 release 정확히 한 번을 검사한다.
- 최소 구현: 최초 오류와 rollback 오류를 모두 보존하고 rollback 실패 연결은 명시적으로 폐기한다. 기존 성공 값과 정상 실패 계약은 유지한다.
- 완료 조건: 이중 실패에서도 최초 원인을 진단할 수 있고 고장 연결 처리 정책이 테스트에 나타난다. 관리자 생성과 일반 리뷰 변이에 같은 원칙이 적용된다.
- 검증: 좁은 단위 테스트, PostgreSQL 통합 테스트, 전체 기본 검사. 실제 네트워크 장애 주입이 없으면 그 범위를 명시한다.
- 위험과 비용: 오류 형식을 바꾸는 경우 상위 로깅·에러 변환을 확인한다. 자동 재시도는 추가하지 않는다.

### U6 현재 안내의 사실 일치

- 범위: 한영 local demo·getting started, CHANGELOG와 미게시 릴리스 후보 설명, 현재 상태 링크.
- 완료 조건: 같은 탭 reload 복구·12시간 만료·로그인/프로젝트/버전 격리·탭/기기 간 동기화 미지원이 일치한다. pinned CI DB는 17.11로 안내한다. 게시되지 않은 다운로드를 이미 존재하는 것처럼 안내하지 않는다.
- 검증: 구현/브라우저 검사와 문구 대조, 상대 링크 검사. 문서 변경에 형식적인 단위 테스트를 추가하지 않는다.
- 역사 보존: 과거 SHA의 실행 결과는 바꾸지 않는다. 현재 안내로 잘못 연결된 문서에는 기준 날짜와 후속 링크를 명확히 한다. 설계상의 역할·상한·미래 항목은 구현과 제안을 구분한다.

## 2단계 릴리스와 배포 증거 연결

### U4 게시 digest를 검증 결과에 묶기

두 방식 중 하나만 채택한다. 한 번 빌드한 이미지를 검사 후 불변 artifact로 publish에 전달하거나, 게시한 candidate의 digest를 `RESTORE_TEST_IMAGES`로 지정해 기존 복원 검사를 수행한 뒤 승격한다. 후자는 기존 candidate promotion 경로를 활용하기 쉽지만 다운로드·검사 비용이 든다. 전자는 빌드 중복을 줄이지만 artifact 크기와 runner 간 전달을 관리해야 한다.

- 의존성: U1 이후 검사 기준과 대상 이미지가 확정돼 있어야 한다.
- 완료 조건: 복원·smoke 결과에 최종 registry digest가 남고 promotion/deploy 입력과 일치한다. 다른 digest나 누락 증거는 거절한다. PR 검사는 registry 쓰기 없이 계속 가능하다.
- 검증: workflow 데이터 흐름 검사, digest 불일치 실패 테스트, 후보 이미지 1세트의 실제 smoke·notice·restore·promotion identity 대조.
- 제외: 새 범용 배포 플랫폼, floating base tag, source SHA만 비교하고 이미지 증거가 같다고 처리하는 방식.

### U5 이전 버전의 실제 복구 계약

- 의존성: 복구 지원 대상으로 삼을 이전 이미지 digest와 schema 기준을 먼저 지정한다. 정식 릴리스가 아직 없다면 실제 이전 배포 digest 또는 지원 시작 시점을 명시한다.
- 검증 흐름: 이전 이미지로 가상 데이터 준비 → 신규 migration → 이전 Gateway의 로그인·댓글 읽기·쓰기 → 새 Gateway 전환 실패 → 이전 컨테이너 복구 → 기존·신규 데이터 확인.
- 완료 조건: 양쪽 image digest와 schema version이 증거에 남고, migration 직후 이전 코드 및 복구 이후 이전 코드의 계약이 통과한다. 현재 버전의 전체 dump/restore 검사도 유지한다.
- 적용 시점: schema·상태 값·저장 형식이 바뀌는 릴리스 전에 필수화한다. 호환 불가능 변경은 expand/contract 이행과 별도 복구 절차를 먼저 설계한다.
- 제외: 데이터 손실 위험을 검토하지 않은 자동 down migration. FakeDocker 순서 검사를 실제 DB 호환 검사라고 보고하는 것.

### O1 승인된 운영 배포 완료

- 선행 확인: 현재 서버 release와 worker hash를 관리 경로로 확인한다. 9월 실패 이후 상태를 추측하지 않는다.
- 실행 범위: 검토한 `deploy_gateway.py`·`receive-deployment.py` 설치 → hash 일치 확인 → 정한 SHA/digest 배포 → readiness·공개 canary·admission 확인. 기존 자동배포 전용 키의 제한을 우회하지 않는다.
- 완료 조건: 해당 배포 job 성공, 서버 current-release의 SHA/digest 일치, 공개 검사와 admission 정상, 이전 컨테이너 복구 가능성이 기록된다.
- 이번 분석 상태: 운영 접속·설치·재배포는 수행하지 않았다. 실제 실행은 명시적으로 승인된 배포 작업에서 진행한다.

### 첫 릴리스 게시

U1과 선택한 출시 기준을 충족한 뒤 [기존 릴리스 절차](../releasing.md)를 사용한다. source·Client·integration 설치 파일, checksum, 이미지 digest, 지원 범위와 migration/rollback 안내가 같은 후보를 가리켜야 한다. 릴리스 게시 후 빈 환경에서 다운로드·설치·공유·리뷰 저장을 확인해야 완료다. GitHub About은 현재 이미 작성돼 있어 미완료 기능으로 세지 않는다. 홈페이지·topics는 실제 공개 안내가 준비됐을 때 맞추면 된다.

## 3단계 작은 팀의 사용 흐름 확인

### 정상 호환성 검사의 빈 부분 보완

현재 고정 조합은 Vite 8.2.2, Next 16.3.3, React 19.2.8, Chrome이다. Next 버전은 U1에서 바꾼 결과로 갱신한다. 기존 검사는 HMR·Fast Refresh·Server Action·탐색·리뷰·권한 회수를 다루지만, 다음은 별도의 인수 조건이다.

| 추가할 때의 조건 | 좁은 검사 | 완료 조건 |
| --- | --- | --- |
| streaming을 제품 계약으로 설명 | fallback 선도착과 지연 본문 도착 관찰 | 최종 텍스트 표시뿐 아니라 실제 증분 도착 확인 |
| CSS HMR과 개발 오류 복구를 지원 기준에 포함 | CSS 변경, 의도적 개발 오류, 정상 소스로 복구 | 공유 URL에서 스타일 갱신과 개발 오류 복구 확인 |
| 특정 브라우저·bundler·버전 수요 발생 | 포장된 integration을 해당 조합에 설치 | 성공한 조합만 지원 행렬의 검증 칸에 추가 |

기존 peer 범위를 전부 실행한 것으로 간주하지 않는다. 현재 fixture의 패키징 검증은 `--legacy-peer-deps` 설치와 루트의 프레임워크 실행 파일을 사용하므로, 독립 소비자 버전 행렬과 구분한다. Vite HTML hook은 모든 Vite 기반 프레임워크가 호출하는 계약이 아니다. [Vite Plugin API](https://vite.dev/guide/api-plugin), [Next CLI](https://nextjs.org/docs/app/api-reference/cli/next)를 기준으로 범위를 적는다.

### 알림과 키보드 사용성

알림을 펼친 상태의 읽기 위치를 유지하면서 새 알림 존재를 알려야 하는지 파일럿에서 확인한다. 필요하면 새 알림 배지 또는 새로고침 버튼부터 추가한다. 열린 목록의 polling 조건만 없애 과거 페이지를 계속 덮어쓰는 방식은 피한다. 완료 조건은 새 알림 인지, 기존 페이지·스크롤·포커스 보존, 숨긴 탭·종료 시 정리다.

키보드는 댓글 작성 → 전송 → 스레드 이동 → 해결·재검토 → 닫기까지 실제 작업으로 검사한다. 추가 구현은 재현된 막힘에 한정하고, 기존 IME·초안·focus 회귀를 유지한다. 검사하지 않은 보조기술까지 적합성 인증을 주장하지 않는다.

### 파일럿의 종료 조건

가상 데이터로 개발자와 검토자가 설치·공유·리뷰 작성·개발 중 갱신·재검토·공유 종료 후 대화 확인을 수행한다. 단계별 성공 여부와 막힌 이유를 기록한다. 공유 성공률·첫 URL 시간·리뷰 저장 실패·알림 인지 지연은 표본과 환경을 함께 남긴다. 이 결과로 가장 많이 막히는 한 흐름을 다음 업데이트로 선택하면 파일럿 분석이 완료된다. 임의의 일정·성능 목표나 사용자 수는 지금 정하지 않는다.

## 정기 유지보수 후보

공식 페이지 확인일은 2026년 10월 9일이다. 새 버전이 있다는 이유만으로 현재 버전을 취약하거나 지원 종료라고 판단하지 않는다.

| 대상 | 현재 기준 | 공식 확인과 처리 |
| --- | --- | --- |
| Node | major 24, Docker base digest 고정 | [24는 LTS, 최신 LTS 표시는 24.21.0](https://nodejs.org/en/about/previous-releases). 실제 image inventory의 patch를 먼저 확인하고 필요한 digest만 갱신한다. 26 Current로 즉시 이동할 이유는 없다. |
| PostgreSQL | 17.11, digest 고정 | [17.11은 17의 최신 minor, 지원 종료는 2029년 11월 8일](https://www.postgresql.org/support/versioning/). 17을 유지하고 minor 갱신 때 DB·복원 검증을 수행한다. |
| Vite | 8.2.2 | [8.2도 중요 수정·보안 수정 대상](https://vite.dev/releases)이다. 8.3 계열은 별도 호환 검사 후 선택하며 단순 EOL 주장은 제외한다. |
| Biome | 2.5.11 | [2.5.15](https://github.com/biomejs/biome/releases/tag/@biomejs/biome@2.5.15)를 작은 변경으로 검토한다. lint와 style contract의 고정값을 함께 확인한다. |
| Playwright | 1.62.1 | [1.64.0](https://github.com/microsoft/playwright/releases/tag/v1.64.0) 갱신은 browser·demo·restore 회귀를 함께 수행하는 별도 작업으로 둔다. |
| setup-node | v7.0.0의 SHA | [v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)의 runner 계약 확인 후 검토한 SHA로 갱신한다. |
| checkout | v7.0.1의 SHA | 확인한 [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)을 유지한다. |
| ws | lock 8.21.3 | [8.22.0](https://github.com/websockets/ws/releases/tag/8.22.0)은 선택적 유지보수다. 적용 시 root/runtime lock 동기화와 전송·패키징 회귀를 확인한다. |
| argon2 | lock 0.45.1 | 확인한 [0.45.1](https://github.com/ranisalt/node-argon2/releases/tag/v0.45.1)을 유지한다. 불필요한 교체는 하지 않는다. |

## 요구가 생길 때만 진행할 확장

| 조건 | 필요한 설계와 완료 기준 |
| --- | --- |
| 서로 신뢰하지 않는 여러 팀 수용 | 프로젝트 membership·권한 회수·기존 데이터 이행을 정의하고 읽기·쓰기·알림·이벤트까지 권한 격리를 검증한다. 공개 초대보다 선행한다. |
| 단일 Gateway 용량 또는 가용성 한계가 측정됨 | route 소유권·재연결·공유 제한·실패 복구를 정의한다. PostgreSQL 공유만으로 해결됐다고 판단하지 않는다. |
| 앱 밖 알림 수요 확인 | 수신 동의·목적지·수신 권한·재시도·중복 방지·취소를 정의한 뒤 한 채널부터 추가한다. |
| 스크린샷이나 첨부가 필요함 | 사용자 확인, 접근 범위, 용량, 보존·삭제를 먼저 정의한다. 자동 화면 수집을 기본으로 켜지 않는다. |
| 탭·기기 간 초안 또는 버전 간 리뷰 승계 수요 | 충돌, 로그인 격리, 보존, 위치가 사라진 리뷰의 의미를 결정한다. 현재 sessionStorage를 서버 동기화로 단순 교체하지 않는다. |

이 표는 기능 개발 착수 목록이 아니다. 현재 비용 대비 효과가 확인되지 않은 Kubernetes·마이크로서비스 분리·범용 이벤트 플랫폼·전면 UI 재작성은 우선순위에서 제외한다.
