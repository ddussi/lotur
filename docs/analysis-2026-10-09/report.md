# Review Tunnel 전체 프로젝트 분석

Review Tunnel은 **로컬 웹 앱 공유와 영속적인 화면 리뷰를 함께 제공하는 소규모 신뢰 팀용 알파**다. 현재는 핵심 구조를 다시 설계하기보다 의존성 갱신, 재현된 목록 오류, 배포와 복구 검증을 먼저 마무리하는 편이 타당하다. 코드에 이미 있는 인증·동시성·복원 방어를 보존하면서 실제 사용자 피드백으로 다음 기능을 선택해야 한다.

기준은 2026년 10월 9일 확인한 `main`의 `ae8d8bc52b289b9ac50d36c9ed53224a2d0a679b`다. 시작 시 작업 트리는 깨끗했고 fetch 후 `origin/main`과 차이는 0/0이었다. 전체 추적 파일 345개의 검토 방식과 Git blob은 [파일별 기록](inventory.json)에 있다. 이 문서는 분석 결과이며 제품 코드 수정이나 배포 완료 보고가 아니다.

[업데이트 순서와 완료 조건](roadmap.md) · [실행 결과와 판정 근거](validation.md)

## 프로젝트가 제공하는 것

개발자는 Client로 자신의 loopback HTTP 앱을 공유한다. Gateway가 인증된 검토자에게 HTTP·SSE·WebSocket을 중계하고, 선택적으로 화면 리뷰 UI를 제공한다. PostgreSQL에는 계정과 리뷰가 남으므로 터널이 종료돼도 프로젝트·버전별 대화와 리뷰함을 사용할 수 있다. Vite와 Next 통합은 개발 중 리뷰 UI 삽입을 돕는다.

| 영역 | 현재 역할 | 유지해야 할 경계 |
| --- | --- | --- |
| Client와 relay | 로컬 origin 확인, 활성화, 흐름 제어, 재연결 | 준비가 끝나기 전 성공 URL을 알리지 않기, 이전 연결의 작업이 새 연결을 바꾸지 않기 |
| Gateway | 인증, 요청 중계, 리뷰 API와 UI, 운영 상태 | 중계·인증·리뷰의 서로 다른 실패를 구분하고 공유 수명 관리 |
| protocol과 proxy | wire 형식, 상태 전이, HTTP 투영 정책 | 프레임·헤더·쿠키·origin 계약을 명시적으로 유지 |
| auth와 review | 권한·계정·댓글·재검토 판단 | 저장소 구현과 분리, 동시 변경 시 현재 권한과 버전 검증 |
| storage-postgres | 영속 상태, 잠금, migration, 트랜잭션 | 본문·이벤트·알림의 원자성, 목록 스냅샷과 커서 순서 |
| 운영 도구 | 설치, demo, 이미지 게시, 배포, 백업·복원 | 대상 identity 확인, 승인된 실행, 실패 시 진단과 복구 |

현재 권한은 배포 전체에 적용되고 활성 터널은 단일 Gateway 메모리에 있다. 프로젝트별 외부 고객 격리나 다중 Gateway 운영은 지원 기능으로 간주하면 안 된다. 이 경계는 [SECURITY.md](../../SECURITY.md)에 명시돼 있다.

## 잘한 점과 보존할 이유

**도메인과 외부 구현의 경계가 실제 검증에 사용된다.** 리뷰 서비스는 저장소·시간·ID 생성 의존성을 받고, 세션 상태 전이는 명시적인 시간을 입력으로 받는다. 같은 계약을 메모리 저장소와 PostgreSQL에서 확인할 수 있다. 새로운 DI 프레임워크를 넣을 이유는 발견하지 않았다. 근거는 [review-service.ts](../../packages/review/src/review-service.ts), [session-state.ts](../../packages/protocol/src/session-state.ts), [경계 검사](../../scripts/check-boundaries.mjs)다.

**데이터 무결성 방어가 UI 바깥에 있다.** 현재 권한과 변경 버전을 DB 변이 경계에서 확인하고, 리뷰 변경·이벤트·알림을 트랜잭션에 묶는다. feed 잠금은 이벤트 순서와 커서의 관계를 보호하고, 목록은 repeatable-read 스냅샷을 사용한다. 마지막 활성 관리자 보호도 저장소 잠금 안에서 처리한다. [PostgreSQL 리뷰 저장소](../../packages/storage-postgres/src/postgres-review-repository.ts), [이벤트 트랜잭션](../../packages/storage-postgres/src/review-event-transaction.ts), [인증 저장소](../../packages/storage-postgres/src/postgres-auth-repository.ts)를 확인했다. PostgreSQL의 [스냅샷](https://www.postgresql.org/docs/17/transaction-iso.html)과 [잠금 계약](https://www.postgresql.org/docs/17/explicit-locking.html)에도 부합한다.

**비동기 작업과 재접속을 별도의 문제로 다룬다.** 연결 세대와 stream identity를 확인해 늦게 끝난 인증·heartbeat·활성화 작업이 새 연결을 해치지 않도록 한다. timeout 이후 실제 작업이 끝날 때까지 admission을 유지하는 검사도 있다. [transport epoch 회귀](../../apps/gateway/src/transport-epoch.test.ts), [deadline 회귀](../../apps/gateway/src/upgrade-deadline.test.ts), [Client 시작 흐름](../../apps/client/src/main.ts)이 근거다.

**사용자의 작성 중 입력을 보호한다.** 초안은 로그인·계정·프로젝트·버전별로 분리되며 같은 탭의 sessionStorage 복구와 12시간 만료를 지원한다. 제출 중 추가로 입력한 내용은 제출 세대가 다르면 지우지 않는다. 저장소가 차단되거나 가득 찬 경우까지 모든 환경의 복구를 보장한다는 뜻은 아니다. [drafts.ts](../../apps/gateway/src/review-ui/drafts.ts)와 [브라우저 회귀](../../tests/review/review-overlay.spec.mjs)를 확인했다.

**운영 도구와 검증이 단순 성공 경로에 그치지 않는다.** 백업에는 private 파일·부분 파일·fsync·rename 처리가 있고 복원에는 입력 검증과 단일 트랜잭션이 있다. CI는 실제 PostgreSQL, 브라우저, demo, 6개 runtime 이미지, 현재 버전의 전체 데이터 복원까지 검사한다. 배포 worker hash가 다를 때 거절하는 현재 실패도 이 방어가 작동한 사례다. [백업](../../scripts/postgres-backup.mjs), [복원](../../scripts/postgres-restore.mjs), [CI](../../.github/workflows/ci.yml), [배포 receiver](../../scripts/receive-deployment.py)를 확인했다. 복원 트랜잭션의 보장 범위는 [PostgreSQL 공식 설명](https://www.postgresql.org/docs/17/app-pgrestore.html)과 함께 해석해야 한다.

## 지금 필요한 개선

우선순위는 프로젝트 작업 순서다. 보안 스캐너 등급이나 실제 운영 장애 등급과 동일하지 않다.

| ID | 우선순위와 분류 | 판단 |
| --- | --- | --- |
| U1 | P1 의존성 및 CI | 현재 root workspace 감사가 실패한다. 개발·통합 의존성을 수정 버전으로 갱신해야 한다. |
| U2 | P2 확정 기능 오류 | 필터 전환 직후 더 보기를 누르면 정상 새 목록이 버려지고 이전 목록과 오류가 남는다. |
| U3 | P2 확정 진단 오류 | ROLLBACK까지 실패하면 최초 작업 오류가 사라진다. |
| U4 | P2 검증 공백 | 종합검사를 통과한 이미지와 최종 게시 이미지가 같은 산출물이라는 연결이 없다. |
| U5 | P2 릴리스 계약 | 이전 Gateway와 새 DB schema의 실제 읽기·쓰기·복구 검증이 없다. |
| U6 | P2 사용자 문서 | 현재 사용 안내와 릴리스 후보의 초안 보존 설명이 구현과 다르다. |
| O1 | 배포 목표일 때 우선 처리 | 기준 SHA의 자동배포가 worker hash 불일치로 거절됐다. 현재 서버 상태는 별도 확인이 필요하다. |

### U1 개발 의존성과 지원 버전 갱신

2026년 10월 9일 `npm audit --omit=dev`는 Next 16.3.3, sharp 0.35.4, source-map-js 1.2.1을 보고하고 exit 1로 끝났다. 총 3개 패키지에 9개 권고가 있으며 집계 등급은 critical 1개와 high 2개다. root에서 Next는 devDependency인 동시에 workspace integration의 peer dependency여서 `--omit=dev` 결과에도 포함된다. 따라서 현재 CI의 같은 감사 단계도 이 결과를 처리해야 한다.

반면 실제 운영용 `deploy/runtime` 잠금 파일에는 세 패키지가 없고, 해당 범위의 감사 결과는 알려진 npm 권고 0건이다. **이 결과로 Gateway의 원격 코드 실행 취약성을 확정하지 않는다.** 운영 이미지 OS 패키지나 소비자 로컬 앱까지 안전하다는 뜻도 아니다. 고정 fixture에는 여러 권고의 필수 기능이 없지만 개발 서버 MCP·SVG 처리·source-map의 소비 경로에는 추가 확인이 필요하다. 세부 판정은 [검증 기록](validation.md)에 있다.

최소 작업은 Next 16.3.8 이상 검증된 16.x 패치, sharp 0.35.5 이상, source-map-js 1.2.2 이상을 만족하는 의존성 해석으로 갱신하고 peer 지원 하한·설치 안내·통합 검증을 함께 맞추는 것이다. `audit fix --force`로 일괄 변경하지 않는다. [Next 16.3.8 수정 내역](https://github.com/vercel/next.js/releases/tag/v16.3.8), [sharp 권고](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w), [source-map-js 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)를 직접 대조했다.

### U2 필터와 더 보기 요청 상태 정합성

[review-control-view.ts 119행](../../apps/gateway/src/review-control-view.ts)의 `load`는 필터가 바뀌어도 이전 cursor와 더 보기 버튼을 즉시 무효화하지 않는다. OPEN 목록의 다음 cursor가 있는 상태에서 ALL로 바꾸고 첫 응답 전에 더 보기를 누르면, 새 필터와 옛 cursor가 함께 전송된다. 두 번째 요청이 sequence도 증가시켜 먼저 진행하던 정상 응답이 버려진다.

실제 UI 소스와 실제 리뷰 서비스를 연결한 좁은 VM 재현에서 이전 OPEN 100행과 `REVIEW_INVALID_INPUT`가 남고 기대한 RESOLVED 행은 표시되지 않았다. DOM·통신 지연은 모사했다. 서버의 [cursor scope 검사](../../packages/review/src/review-service.ts)가 요청을 거절하므로 데이터 혼합이나 접근 권한 우회로 확대하면 안 된다.

필터 변경 시 cursor를 비우고 첫 페이지가 확정될 때까지 더 보기를 비활성화하는 작은 변경이 적절하다. 응답뿐 아니라 오류에도 현재 조회 세대 검사를 적용해야 한다.

### U3 트랜잭션의 두 실패 원인 보존

[postgres-transaction.ts 16행](../../packages/storage-postgres/src/postgres-transaction.ts)은 catch에서 ROLLBACK을 먼저 await한다. 그 작업도 실패하면 최초 업무·SQL 오류를 throw하는 줄에 도달하지 못한다. [첫 관리자 생성](../../packages/storage-postgres/src/postgres-auth-repository.ts)에도 같은 구조가 있다. 실제 helper와 실패하는 stub client로 최초 오류 소실을 재현했다.

두 오류를 함께 보존하고 rollback 실패 연결의 폐기 정책을 명시하는 것이 적절하다. pg는 일부 고장 연결을 스스로 제거하므로 “항상 망가진 연결을 재사용한다”는 주장은 제외했다. [pg pool의 release 계약](https://node-postgres.com/apis/pool)은 명시적인 연결 폐기를 지원한다. 자동 재시도를 추가하면 변이 중복 문제가 생기므로 이번 개선 범위에 넣지 않는다.

### U4 최종 이미지에 검증 증거 연결

[CI 85행](../../.github/workflows/ci.yml) 부근의 verification은 이미지를 빌드하고 같은 로컬 image ID로 복원 검사를 한다. 그러나 publish는 별도 runner에서 3개 이미지를 다시 빌드한다. 수동 candidate도 별도 빌드다. 소스 SHA가 같다는 사실은 최종 registry digest에 복원 검사를 했다는 증거와 다르다.

base digest·lock 고정과 candidate identity 검사가 이미 있어 실제 잘못된 이미지가 배포됐다고 판단하지 않는다. 한 번 만든 이미지를 검사 후 전달하거나, 최종 candidate digest에 기존 복원 검사를 연결하는 방식 중 운영 비용이 작은 쪽을 선택하면 된다. [Docker digest 고정의 범위](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions)를 확인했다.

### U5 이전 코드와 새 schema의 호환 검사

[deploy_gateway.py 270행](../../scripts/deploy_gateway.py)은 이전 Gateway가 살아 있는 동안 새 migration을 수행하고, 이후 실패하면 이전 컨테이너를 복구한다. DB migration은 되돌리지 않는다. 이 정책은 이전 코드가 새 schema를 읽고 쓸 수 있어야 한다.

현재 배포 테스트는 FakeDocker로 순서를 검증하고, [restore-runtime.mjs 68행](../../tests/release/restore-runtime.mjs)은 이미지가 모두 현재 HEAD여야 한다. 기존 복원 검사는 가치가 크지만 실제 구버전 호환 검사를 대신하지 못한다. **현재 migration이 깨졌다는 증거는 없다.** 복구 대상으로 약속할 이전 이미지가 정해지면 새 migration 이후 그 이미지의 로그인·리뷰 읽기·쓰기·복구를 검사해야 한다. 무조건적인 down migration 추가는 권하지 않는다.

### U6 현재 안내와 역사 기록 분리

[local-demo.md 36행](../local-demo.md), [영문 안내](../local-demo.en.md), [getting-started.md 197행](../getting-started.md), [CHANGELOG 72행](../../CHANGELOG.md), [릴리스 후보 안내](../releases/0.1.0-alpha.1.md)는 새로고침 시 초안이 사라진다고 적지만, 현재 구현은 같은 탭에서 sessionStorage 복구를 지원한다. [영문 시작 안내 135행](../getting-started.en.md)의 pinned CI PostgreSQL 17.6도 현재 17.11과 다르다.

[poc-status.md](../poc-status.md)는 9월 9일 SHA의 기록인데 [문서 안내](../documentation.md)에서 현재 구현으로 연결된다. 역사 문서의 숫자와 결과를 덮어쓰기보다 현재 안내를 별도로 맞추고 과거 기록의 기준 SHA를 보존해야 한다. 설계 문서의 역할·상한·미래 후보 역시 구현 상태와 구분하면 된다. 문서에 적힌 상한을 구현된 보호라고 자동 인정하지 않았다.

### O1 배포가 멈춘 이유와 조치 범위

기준 SHA의 [GitHub Actions 실행](https://github.com/ddussi/lotur/actions/runs/35602749137)은 2026년 9월 21일 verification와 publish 성공, deploy 실패다. 실패 로그는 서버에 설치된 worker의 hash가 다르다고 보고한다. [receiver 20행](../../scripts/receive-deployment.py)의 검사는 migration이나 컨테이너 교체 호출 전에 거절한다. 의도한 보호이므로 guard를 없애면 안 된다.

[기존 운영 절차](../automatic-deployment.md)에 따라 검토한 worker를 관리 경로로 설치하고 hash를 맞춘 뒤 승인된 배포를 수행해야 한다. 이 실행 이후 수동 배포 여부와 현재 운영 상태는 확인하지 않았으며, 현재 서비스가 중단됐다고도 판단하지 않는다.

## 앞으로의 제품 방향

첫 파일럿에서 검증할 가설은 “개발 서버 공유부터 리뷰 작성·수정·재검토까지 한곳에서 끝내는 경험이 작은 팀의 확인 비용을 줄인다”이다. 자체 호스팅과 영속 리뷰의 조합은 제품 설명에 쓸 수 있지만 시장에서 입증된 우위는 아니다.

외부 제품도 로컬 공유와 리뷰를 지원한다. [ngrok](https://ngrok.com/use-cases/share-localhost)은 로컬 공유와 인증 옵션을, [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/concepts/routing/)은 hostname과 로컬 서비스 연결을 제공한다. [Vercel Toolbar](https://vercel.com/docs/vercel-toolbar/in-production-and-localhost)는 localhost에서도 댓글 기능을 제공하므로 “로컬 화면 리뷰는 유일하다”는 소개는 부정확하다.

현재 [GitHub 저장소](https://github.com/ddussi/lotur)의 About 설명은 이미 채워져 있다. 홈페이지와 topics는 비어 있고, 인증된 Releases 조회에서는 게시·초안 릴리스 합계가 0개였다. 제품 소개문을 새로 쓰는 것보다 실행 가능한 설치 경로와 검증된 첫 릴리스를 연결하는 일이 더 중요하다. 실제 게시와 외부 변경은 별도 작업이다.

파일럿에서는 공유 성공 여부, 첫 URL까지 걸린 시간, 리뷰 저장 실패, 다른 사람이 새 리뷰를 인지하는 시간, 재검토 완료 흐름을 관찰하면 된다. 기존 [metrics](../../apps/gateway/src/metrics.ts)를 먼저 활용하고 사용자 입력 본문이나 토큰을 수집하지 않는다. 임의의 가용성 목표를 먼저 선언하기보다 실제 사용자 흐름으로 측정 대상을 정하라는 [SRE 지침](https://sre.google/workbook/implementing-slos/)을 적용한 제안이다.

알림 창을 펼치면 polling을 멈추는 것은 읽는 위치를 보존하려는 문서화된 선택이다. 필요하다면 목록을 바꾸지 않는 새 알림 표시나 명시적 새로고침을 추가한다. 키보드 흐름은 포커스 보존 검사가 이미 있지만 전체 접근성 인증은 아니다. 파일럿에서 실제 막히는 경로부터 [WAI 키보드 원칙](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)으로 검증하는 편이 낫다.

프로젝트별 권한은 서로 신뢰하지 않는 팀을 한 서버에 받기 전에 필요하다. 다중 Gateway는 가용성·용량 요구가 확인될 때, 외부 알림은 수신 동의·권한·중복 처리 규칙이 정해질 때 진행한다. 스크린샷·기기 간 초안·리뷰 승계는 보존과 충돌 의미를 먼저 정의해야 한다. 현재 근거만으로 이 기능들을 동시에 만들거나 핵심을 다시 설계할 이유는 없다.

## 판단의 한계

이 결과는 모든 버그의 부재, 독립 보안 인증, 실제 팀 사용성이나 운영 성능의 증명이 아니다. 영상은 메타데이터만 확인했고 운영 서버에 접속하거나 최신 HTTPS 경로를 실행하지 않았다. 테스트 통과 범위, 생성 파일 검토 방식, 서브에이전트 중단과 미검증 후보, 제외한 과장 주장은 [검증 기록](validation.md)에 남겼다. 실제 제품 수정·커밋·push·배포는 수행하지 않았다.
