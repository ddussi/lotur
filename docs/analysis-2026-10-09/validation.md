# Review Tunnel 분석 검증 기록

분석 기준일은 2026년 10월 9일, 소스는 `ae8d8bc52b289b9ac50d36c9ed53224a2d0a679b`다. 코드·문서의 사실, 실제 실행 결과, 외부 권고, 아직 확인하지 않은 조건을 분리한다. [종합 판단](report.md)과 [업데이트 계획](roadmap.md)은 이 기록의 범위 안에서 해석한다.

## 완료 조건과 검토 범위

| 분석 Goal의 완료 조건 | 결과 |
| --- | --- |
| 저장소·브랜치·원격 기준 확정 | `ddussi/lotur`, main, 위 SHA. 시작 시 clean, fetch 성공, origin/main과 0/0 |
| 전체 추적 파일의 검토 상태 기록 | 345/345 경로를 [inventory.json](inventory.json)에 기록. 누락·중복 경로 없음 |
| 핵심 소스·테스트·문서 읽기 | 팀이 분담한 원문 완독 329개. 나머지 16개는 아래 방식으로 구분 |
| 주요 후보를 루트가 재검토 | UI 경합과 rollback 오류 소실을 좁은 재현으로 확인. 배포/이미지/복구 후보는 코드·로그·기존 방어 대조 |
| 외부 주장 확인 | 공식 기술 문서, upstream release·advisory, 현재 GitHub metadata와 Actions 조회 |
| 필요한 결과 분류 | 확정 오류, 현재 감사 실패, 검증 공백, 제품 제약, 선택적 제안을 구분 |
| 우선순위와 종료 기준 | roadmap에 작업 범위·의존성·완료 조건·검증·제외 범위를 기록 |
| 최종 문서 점검 | 파일 목록·blob·링크·문서 diff를 검사. 제품 코드 변경 없음 |

원문 완독 외 항목은 package manifest 메타데이터 7개, 생성 UI 번들 2개, lock 구조 검사 2개, 과거 생성 inventory 구조 검사 1개, PNG 시각 확인 3개, WebM 메타데이터 확인 1개다. manifest 7개도 전체 필드를 확인했으나 분석 방식은 metadata로 분류했다. 생성 번들 전체를 사람이 한 줄씩 읽었다고 표현하지 않는다. 영상은 재생·전 프레임 확인을 하지 않았다. 추적되지 않은 node_modules·dist 전체와 모든 Git 이력은 345개 원문 검토 범위에 포함하지 않는다.

초기 분담은 전송/Client, 도메인/인증/DB, 운영/CI의 Astra 3개였으며, 잔여 framework 검토에 Astra 1개를 추가했다. 모두 `gpt-6-astra`, `medium`을 명시했다. 실행 도구에는 별도의 Fast/service-tier 입력이 없어 Fast 적용 여부는 확인하지 못했다. 루트는 기준 상태, 문서·미디어, 남은 일반 테스트, 최종 후보의 실제 코드와 반례를 확인했다. 모든 파일을 루트 혼자 완독했다는 뜻은 아니다.

전송 담당의 한 차례 작업이 도구의 사이버 안전성 판정으로 중단됐다. 그 담당은 완독 89개·부분 2개·미검토 30개를 구분해 반환했다. 이후 남은 파일의 정상 동작·기존 테스트 읽기만 별도로 완료했다. 중단된 전송 후보의 재현은 재시도하지 않았고 확정 이슈에 포함하지 않았다. 이 제한은 원문 검토 완료와 별개의 미검증 항목이다.

## 실제 실행 결과

아래 로컬 실행은 같은 세션에서 제품 소스 변경 없이 같은 SHA에 수행했다. 이미 통과한 전체 검사를 분석 분담마다 반복하지 않았다. 표의 DB 검사는 기본 테스트에서 건너뛴 23개를 별도 환경에서 실행한 것이므로 중복 집계하지 않는다.

| 실행 | 확인 결과 | 해석할 범위 |
| --- | --- | --- |
| `npm run check` | exit 0. Biome warning 1·info 49, typecheck·경계 검사·build 통과. script 79/79, app/package 359 pass·23 skip | lint 경고 0건이라는 뜻은 아님. 최초 sandbox 실행은 localhost listen EPERM, 권한을 갖춘 재실행 결과 사용 |
| `npm run test:postgres` | 23/23 pass, skip 0 | 별도의 임시 PostgreSQL 17.6-bookworm 컨테이너. 기존 타 프로젝트 DB 사용 안 함. 종료·삭제 완료 |
| `npm run test:frameworks` | Chrome 24/24 pass | framework와 review 브라우저 흐름. 다른 브라우저 전체 행렬의 증거 아님 |
| U2 좁은 재현 | 필터 ALL, 이전 행 100개 유지, 새 RESOLVED 행 누락, `REVIEW_INVALID_INPUT` | 실제 UI 소스·실제 메모리 리뷰 서비스와 VM DOM/fetch 지연. 실제 브라우저 재현은 별도 후속 검사 |
| U3 좁은 재현 | rollback error가 전파되고 최초 오류 보존 false | 실제 transaction helper + 실패 stub. 실제 PostgreSQL 연결 장애 주입 아님 |
| root `npm audit --omit=dev --json` | exit 1, 패키지 3개·권고 9개, 집계 critical 1/high 2 | 10월 9일 현재 의존성 그래프와 npm 권고 결과. 프로젝트에 3개 취약점이 악용 가능하다는 뜻 아님 |
| runtime `npm audit --prefix deploy/runtime --omit=dev --json` | exit 0, 알려진 npm 권고 0건, 의존성 집계 27 | Gateway 계열의 별도 runtime lock 범위. OS·Node 바이너리·사용자 앱·미공개 문제의 검사 아님 |
| lock 구조 대조 | root 162 entries, runtime 28 entries. runtime 항목의 version/integrity/resolved 불일치 0 | root 항목을 포함한 entry 수이므로 npm dependency 집계와 1 차이. tarball 재다운로드/서명 검증 아님 |

로컬 Node는 24.13.0, npm은 11.6.2였다. PostgreSQL 로컬 실행은 캐시된 17.6이며, 현재 CI와 compose의 고정 버전 17.11 실행이라고 바꿔 적지 않았다.

## GitHub 실행과 현재 상태

읽기 전용 조회에서 기준 SHA의 [Actions 실행 35602749137](https://github.com/ddussi/lotur/actions/runs/35602749137)을 확인했다. 실행일은 **2026년 9월 21일 UTC**이며 10월 9일에 재실행한 결과가 아니다.

- verification 성공: 현재 workflow의 실제 PostgreSQL 17.11, 기본·브라우저·demo·이미지·복원 검사 경로가 성공했다.
- publish 성공: 운영 이미지 게시 단계 성공이다. 별도 build 구조이므로 verification image와 같은 digest였다는 증거로 사용하지 않는다.
- deploy 실패: `Deployment worker changed; install the reviewed server worker before deploying`로 거절됐다.
- candidate 관련 job은 skipped였다. 게시 가능한 첫 릴리스 검증을 모두 새로 완료했다고 주장하지 않는다.

receiver 코드는 worker hash 확인 뒤에만 deployment를 호출한다. 기존 `test_deployment.py`에도 불일치 시 호출하지 않는 검사가 있다. 이 로그만으로 이후 수동 배포 또는 현재 서비스 상태는 판단할 수 없다. 운영 서버 접속·worker 변경·배포 재시도·공개 HTTPS 검사는 이번에 수행하지 않았다.

10월 9일 저장소 metadata는 public, default branch main, About description 있음, homepage 빈 값, topics 없음이었다. 저장소 관리 권한 계정으로 Releases를 조회한 결과 draft 포함 0개였다. 저장소 소유자와 조회 인증 계정의 권한을 구분했고 전역 계정 설정은 바꾸지 않았다. 비밀값·원격 도메인·raw 배포 로그는 분석 문서에 복사하지 않았다.

9월 CI의 감사 통과와 10월 감사 실패는 모순이 아니다. 권고 데이터가 바뀌며, Next의 RCE 권고는 9월 22일, 여러 Next 수정과 sharp 권고는 9월 30일에 공개됐다. source-map-js 권고는 이전 공개일과 이후 갱신일을 구분해야 한다. 당시 감사 결과를 현재의 안전성 증거로 쓰지 않는다.

## 의존성 권고에 대한 정적 판정

Codex Security의 triage-finding 절차로 npm에서 가져온 9개 권고를 입력 순서대로 정리했다. root 및 영향 경로의 SECURITY.md를 resolver로 확인했고 모두 동일한 root 정책이 적용됐다. 판정 범위는 저장소에 있는 first-party 이미지·고정 fixture·integration 구현이다. 별도 사용자가 공유하는 앱의 모든 설정은 포함하지 않는다. 동적 취약점 재현·전체 보안 스캔은 수행하지 않았다.

| 권고 | 현재 first-party 코드에 대한 판정 | 근거와 남은 조건 |
| --- | --- | --- |
| [Next ImageResponse RCE](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) | not_actionable, 높은 확신 | fixture에 해당 SVG ImageResponse route가 없고 공식 runtime에 next가 없다. 사용자의 별도 image route까지 영향 없다는 뜻은 아님 |
| [Draft Mode cache](https://github.com/vercel/next.js/security/advisories/GHSA-3w37-wq28-93x7) | not_actionable, 높은 확신 | fixture에 Draft Mode 및 use cache 기능 없음 |
| [Pages Router SSG/ISR cache](https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676) | not_actionable, 높은 확신 | 고정 fixture는 App Router 개발 앱이며 해당 Pages Router 경로 없음 |
| [개발 서버 MCP 정보 노출](https://github.com/vercel/next.js/security/advisories/GHSA-39w2-rjm5-chcv) | needs_review 1순위, 중간 확신 | next dev는 실제 경로. 브라우저·직접 local 경로·origin 통제가 upstream endpoint에 미치는 영향을 모두 확정하지 않음 |
| [dynamic metadata image](https://github.com/vercel/next.js/security/advisories/GHSA-f87g-xv8r-7p7x) | not_actionable, 높은 확신 | 제한된 dynamic metadata image route가 없으며 fixture는 기본 Turbopack |
| [catch-all SSG/ISR cache](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p) | not_actionable, 높은 확신 | 고정 fixture에 root catch-all과 해당 배포 경로 없음 |
| [Image Optimization SSRF](https://github.com/vercel/next.js/security/advisories/GHSA-cjq9-62q9-8jv4) | not_actionable, 높은 확신 | fixture/helper에 images.remotePatterns 없음. upstream 권고의 적용 제외 조건에 해당 |
| [sharp/librsvg](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) | needs_review 2순위, 중간 확신 | Next optional dependency로 설치. 외부 SVG 도달과 Linux/glibc·바이너리 조건 미확정, 공식 runtime에서는 제외 |
| [source-map-js](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2) | needs_review 3순위, 중간 확신 | Next/Vite의 PostCSS 경로에 설치. 비신뢰 map이 실제 consumer로 들어오는 조건 미확정, 공식 runtime에서는 제외 |

확정된 프로젝트 보안 결함은 이 판정에서 0개, 현재 first-party 경로에 해당하지 않는 권고 6개, 추가 확인 3개다. **not_actionable은 패키지를 계속 오래된 버전으로 두라는 뜻이 아니다.** 현재 CI 감사 실패와 지원 의존성의 안전한 기준 유지를 위해 U1은 진행할 가치가 있다. 일부 upstream advisory에 패치 번호가 `16.3.?`로 남아 있어, 정확한 수정 버전은 [16.3.8 릴리스](https://github.com/vercel/next.js/releases/tag/v16.3.8)와 npm 범위를 함께 대조했다.

원본 npm 결과·적용 정책·9개 항목의 `triage-finding/v0` JSON은 Codex Security의 lotur 전용 persistent artifact collection의 `artifacts/triage-2026-10-09/`에 보존했다. 원격 advisory나 이슈를 생성하지 않았다.

## 루트의 최종 채택과 제외

| 주장 | 최종 판단 |
| --- | --- |
| 필터 경합으로 다른 데이터가 섞이거나 유출된다 | 제외. 실제 서버 scope 검사가 거절한다. 확인한 영향은 목록 오류와 정상 응답 폐기 |
| rollback 실패 연결은 항상 재사용돼 데이터를 오염시킨다 | 제외. pg-pool의 고장 연결 제거가 있다. 최초 오류 소실과 명시적 폐기 정책만 개선 |
| 열린 알림 창이 갱신되지 않으므로 구현 버그다 | 제외. 읽기 위치 보존이라는 명시적 의도. 새 알림 인지 UX는 선택 제안 |
| restore 검사 또는 standalone Client/demo가 없다 | 제외. 현재 구현·검사·후속 역사 기록에 존재 |
| 과거 F01–F08이 현재도 미해결이다 | 제외. 후속 수정 기록과 현재 코드·회귀를 확인. 과거 보고서를 재등록하지 않음 |
| 동일 SHA의 빌드이므로 게시 digest도 종합검사를 받았다 | 제외. publish가 재빌드한다. U4는 실제 차이 발견이 아닌 증거 연결 공백 |
| 컨테이너 rollback이 있으므로 DB 호환도 검증됐다 | 제외. FakeDocker와 현재 버전 restore로 구버전 SQL 호환까지 입증되지 않음 |
| deploy 실패는 서비스가 지금 중단됐다는 뜻이다 | 제외. migration 전에 worker mismatch 거절. 현재 서버 상태는 미확인 |
| 전송의 queue 대기 후보가 확정 결함이다 | 제외. 정적 추론뿐이고 재현·반증 완료 안 됨. 중단된 조사 재시도 없음 |
| 현재 README에 나온 모든 peer 버전·브라우저를 검사했다 | 제외. 실제 고정 fixture·Chrome 범위와 분리 |
| RSC 최종 텍스트 검사는 증분 streaming까지 증명한다 | 제외. fallback/청크 도착 시간 검사는 별도 필요 |
| 현재 초안은 reload하면 반드시 사라진다 | 잘못된 안내로 채택. 저장소 사용 가능 시 같은 탭 sessionStorage 복구 구현과 회귀가 있음 |
| 로컬 화면 댓글은 시장에서 유일한 기능이다 | 제외. Vercel Toolbar의 localhost 댓글 공식 지원 확인 |
| 파일 크기만으로 서비스를 분해하거나 Kubernetes가 필요하다 | 제외. 현재의 실제 변경·용량 요구 근거가 없음 |

## 여전히 확인하지 않은 것

현재 운영 데이터·서버 worker·실제 release digest, 최신 공개 HTTPS의 전체 리뷰 흐름, 운영 부하에서의 지연·복원시간·장애복구 목표, 모든 소비자 앱 설정·브라우저·OS 조합은 이번 분석으로 알 수 없다. 미디어 PNG 3개는 저장된 예제 화면을 시각 확인했으며 현재 실행 화면으로 간주하지 않는다. WebM은 파일 형식·크기·hash만 확인했다. 모든 역사 문서의 외부 URL을 현재 링크 검사로 다시 열지는 않았다.

제품 소스·의존성·서버 설정을 수정하지 않았고, Git 커밋·push·릴리스 게시·외부 메시지·배포를 수행하지 않았다. 새로 작성한 것은 이 분석 문서와 파일별 검토 기록이다.
