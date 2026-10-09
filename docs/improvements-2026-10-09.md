# Review Tunnel 개선 구현과 검증

기준은 `main`의 `ae8d8bc52b289b9ac50d36c9ed53224a2d0a679b`다. 시작 시 기존 변경은 `docs/analysis-2026-10-09/`뿐이며 그대로 보존한다. fetch 후 원격과 차이는 0/0이었다. 아래 채택 항목이 구현되고 명시한 검증을 통과해야 Goal을 완료한다. 커밋·push·릴리스 게시·운영 배포는 이번 범위에 포함하지 않는다.

## 재검증과 범위 결정

| 제안 | 분류 | 현재 근거와 선택 이유 |
| --- | --- | --- |
| U1 의존성 감사 실패 | 이번에 구현 | root 감사 exit 1 재확인. Next 16.3.3·sharp 0.35.4·source-map-js 1.2.1에 공개 권고. 운영 runtime에는 세 패키지가 없으므로 개발·integration 경로만 최소 갱신 |
| U2 필터와 더 보기 경합 | 이번에 구현 | 제어 화면이 필터 변경 시 cursor를 유지하고 append가 sequence를 증가시키는 코드가 남아 있음. 사용자가 정상 목록을 잃는 실제 흐름 |
| U3 rollback 이중 실패 | 이번에 구현 | 공통 helper와 첫 관리자 생성의 catch가 rollback 실패로 최초 오류를 덮음. 진단 원인 보존 및 연결 폐기 계약 보완 |
| U4 검증 이미지와 게시 이미지 연결 | 이번에 구현 | verification 이후 publish와 candidate가 별도 build. 기존 검증 산출물을 그대로 전달해 중복 build와 검증 공백 해결 |
| U6 안내 불일치 | 이번에 구현 | 현재 초안 복구와 안내가 다르고 pinned CI PostgreSQL 버전도 오래됨. 현재 안내를 맞추되 과거 SHA 보고서는 보존 |
| U5 이전 코드와 새 schema 호환 | 후속 검토 | 이번 변경에는 schema 변경이 없고 아직 복구 지원 대상으로 확정한 이전 release/digest가 없음. 다음 schema 릴리스 전에 그 대상을 정해 실제 호환 검사. 현재 restore 검사는 유지 |
| O1 서버 worker 동기화·배포, 첫 릴리스 게시 | 후속 검토 | 실패 guard 자체는 정상. 현재 서버 파일·release 확인과 외부 실행이 필요한 별도 운영 작업이며 코드 수정으로 배포 성공을 주장할 수 없음 |
| RSC 증분 도착·CSS HMR·오류 복구·추가 브라우저 행렬 | 후속 검토 | 현재 기능 불량 근거가 아닌 인수 범위 확대. 이번 변경에 필요한 기존 Chrome/Next/Vite 회귀는 수행 |
| 알림 펼침 중 새 알림 표시·접근성 확장·파일럿 계측 | 후속 검토 | 읽기 위치 보존은 의도한 동작. 실제 막히는 사용자 흐름 또는 측정 요구를 확인한 뒤 국소 개선 |
| 프로젝트 ACL·다중 Gateway·외부 알림·첨부·기기 간 초안 | 후속 검토 | 현재 신뢰 팀 경계의 확장. 권한·보존·충돌·운영 요구를 먼저 확정해야 함 |
| Node major·PostgreSQL major·Biome·Playwright·Actions·ws 일괄 최신화 | 제외 | 이번 확인 문제 해결에 불필요. 지원 중인 major와 고정 버전을 유지하고 해당 권고의 수정 버전만 갱신 |
| 과거 해결 완료 항목 재수정, 미재현 전송 후보, 대형 재설계 | 제외 | 이미 있는 방어·테스트와 중복하거나 확정 근거 없음. 지난 조사에서 중단된 재현도 재시도하지 않음 |
| GitHub About 신규 작성 | 제외 | 기존 조회에서 이미 소개문 존재. 이번 코드 개선과 무관한 원격 변경 불필요 |

## 간결한 작업 목록과 완료 조건

- [x] U1: 해당 권고의 수정 버전으로 lock·Next peer 하한 갱신. root/runtime 감사 통과, clean install 및 기존 framework·production 비활성화·pack 소비자 검사 통과.
- [x] U2: 지연/역순 응답·오류·중복 클릭 브라우저 회귀가 먼저 실패한 뒤 수정 후 통과. 필터와 행 일치, 서로 다른 cursor 혼용 없음, 최신 성공을 이전 오류가 덮지 않음.
- [x] U3: 실패 조합 회귀가 먼저 실패한 뒤 통과. 최초/rollback 원인 모두 보존, rollback 실패 연결 폐기, release 한 번, 첫 관리자 및 일반 transaction 계약 유지.
- [x] U4: 검증 이미지 ID·source·platform·최종 digest 연결. 누락/교체 거절 회귀, CI 조건/권한·candidate 정책 유지. 실제 로컬 Docker 저장/불러오기·identity 흐름 검증. 원격 publish/deploy는 실행하지 않음.
- [x] U6: 현재 사용 안내의 한영 초안 범위·CI DB·설치 지원 버전 정합성, 링크 검사. 과거 분석 파일 원문 보존.
- [x] 통합: `npm run check:mvp`, 실제 PostgreSQL 통합, 필요한 demo·runtime 이미지·복원 검사, 루트의 전체 diff 및 회귀 재검토. 기존 실패와 새 실패를 구분해 기록.

U1을 먼저 정리하면서 서로 파일이 겹치지 않는 U2·U3·U4를 병렬 진행한다. 이후 통합 검사와 문서 정리를 완료한다. 검증 불가 항목을 통과 처리하지 않으며 채택 범위를 난이도 때문에 축소하지 않는다.

## 에이전트 설정과 소유권

공식 모델과 실행 도구는 `light`를 지원값으로 나열하지 않아 가장 낮은 지원값 `low`로 요청했다. 세 구현 에이전트의 `gpt-6-astra`/`low` 요청은 도구가 수락했다. 도구는 별도 Fast/service-tier 입력이나 실제 적용 tier를 반환하지 않아 Fast 적용 여부는 확인할 수 없다. [공식 Astra 설명](https://developers.openai.com/api/docs/models/gpt-6-astra), [Fast 설명](https://developers.openai.com/api/docs/guides/fast-mode).

U2 담당은 제어 화면과 전용 브라우저 테스트, U3 담당은 PostgreSQL transaction과 bootstrap 경로, U4 담당은 CI와 이미지 전달·게시 도구를 수정한다. 루트는 의존성·문서·공유 Playwright 설정·생성 UI·통합 실행을 맡는다. 같은 파일 변경은 사전 조율한다. 서브에이전트는 의존성 설치·커밋·push·배포를 하지 않는다.

## 검증 기록

채택한 구현과 로컬 완료조건을 모두 검증했다. 이전 분석의 검사 통과를 이번 변경 후 결과로 재사용하지 않았다. [정리된 실행 증거](validation/improvements-2026-10-10.json)에 이미지 ID·digest·복원 결과와 한계를 보존했다.

- `npm ci --no-audit`: 성공. lock 변경은 Next 및 동반 SWC/env, sharp 및 동반 바이너리/libvips, source-map-js와 Next peer 하한뿐이다. 운영 runtime lock은 변경하지 않았다.
- root `npm audit --omit=dev`: 수정 전 high 2·critical 1, 수정 후 0. `--prefix deploy/runtime` 감사도 0. 이는 조회 시점의 알려진 의존성 권고 결과이며 소스 전체가 무결하다는 뜻은 아니다.
- `npm run check:mvp`: 성공. 스크립트 84개, 앱/패키지 370개, Chrome 브라우저 34개 통과. 기본 실행에서 DB 23개는 연결 미설정으로 건너뛰었다. 이후 별도 격리 PostgreSQL 17.6에서 DB 23개 모두 통과했고 검증용 컨테이너를 제거했다. 17.6은 기존 캐시를 이용한 결과이며 CI의 pinned 17.11 실행과 구분한다. 기존 lint warning 1개·info 49개는 유지됐다.
- U2 브라우저 10개는 각 필터·응답/오류 역순·더 보기 중복·실패 재시도를 검증한다. 루트 재검토에서 첫 페이지 실패 시 이전 필터의 행이 남는 문제를 추가 발견해 실패 재현 후 수정했다. 전체 브라우저 회귀에도 포함했다.
- U3 실패 조합 및 bootstrap 검사 13개 통과. 설치된 `pg-pool`의 `release(true)`가 연결 제거로 이어지는 구현을 루트가 확인했다. 기존 계정이 있을 때 읽기 전용 transaction 종료가 rollback에서 commit으로 바뀌지만 계정·감사 쓰기는 없고 반환값 `false`와 advisory lock은 유지된다. 실제 네트워크 장애 주입은 이 테스트의 범위가 아니다.
- U4 스크립트의 누락·교체·다른 실행 attempt·label/platform 불일치 거절과 게시 digest를 다시 가져온 뒤 ID 대조를 확인했다. 실제 Docker 결과는 아래 재개 후 기록에 있다. 원격 Actions·GHCR 게시는 실행하지 않았다.
- U6 초안 저장 코드를 직접 대조하고 현재 한영 안내·릴리스 초안·게시 절차를 정정했다. 9월 구현 보고서는 당시 본문을 유지하고 역사적 기록으로 표시했다.
- 최종 문서 상대 링크 160개에 누락 없음. `npm run check:review-ui`와 `git diff --check` 통과. 장시간 작업 후 다시 fetch했고 `HEAD...origin/main`은 0/0이었다. 커밋·push·원격 게시·배포는 하지 않았다.
- 검증 환경 디스크 여유가 처음 1.4GiB, 브라우저 검사 후 약 332MiB였다. 다른 작업의 cache·image·volume을 임의로 삭제하지 않고 사용하지 않는 Docker 빌드 캐시 정리 허용 여부를 요청했다. 공간이 필요한 실제 이미지 검증은 답변/공간 확보를 기다리며 Goal은 완료하지 않았다.
- U4 재검토에서 Docker 29.2.0/containerd의 `inspect.Id`가 config 대신 manifest/index digest인 점을 캐시 이미지와 [해당 버전 공식 구현](https://github.com/moby/moby/blob/docker-v29.2.0/daemon/containerd/image_inspect.go#L85-L101)으로 확인했다. 기존 candidate v1의 `configDigest`는 실제 Docker ID를 기록·비교하던 필드여서 호환성을 유지하고 설명 주석을 추가했다. 새 일반 게시 증거는 별도 `review-tunnel-published-images-v1` 형식과 `verifiedImageId` 필드로 의미를 명확히 했다. 현재 저장 방식에서 실제 save/load·push·digest pull이 모두 같은 ID를 유지했으며, 다른 image store 간 호환은 입증하지 않았다. ID 검사를 약화하는 대체 동작은 추가하지 않았다.

## 2026-10-10 재개 후 결과

- 사용자의 공간 확보 후 재개했다. 첫 빌드 중 Docker 빌드 이력 조회가 내부 panic으로 끝났고 daemon이 중지됐다. 데이터 초기화 없이 Docker Desktop을 재시작했다. 정체된 자격증명 도우미 대신 기존 설정을 보존한 임시 익명 Docker 설정으로 공개 베이스 이미지를 읽었다. 실패한 환경 시도를 검사 통과로 세지 않았다.
- 여섯 `linux/amd64` runtime 이미지 빌드 완료. 여섯 진입점의 잘못된 설정 거절, Client 버전, 모든 설치 패키지·라이선스 검사 통과. 실제 이미지의 npm 목록에 Next·sharp·source-map-js가 없음을 확인했다.
- CI와 같은 pinned PostgreSQL **17.11**에서 통합 테스트 **23개 통과**, demo/독립 Client/중단 복구 브라우저 테스트 **3개 통과**, 실제 백업·새 DB 복원 테스트 **1개 통과**. 복원에서 24개 테이블과 sequence 2개의 상태 보존, 최소 DB 권한, 반복 migration, 새 로그인·알림 수신자 분리·재검토·재공유를 확인했다.
- smoke·복원 후 CLI `seal`로 **255,681,024 bytes** archive 저장. 이번에 만든 여섯 태그를 전부 제거하고 존재하지 않음을 확인한 뒤 `load`했다. 여섯 ID·source·version·platform이 모두 일치했다. 누락·ID 교체·target 간 ID 교환·다른 attempt도 실제 이미지로 거절됨을 확인했다.
- Docker VM 내부 **루프백 전용 일회용 레지스트리**에서 여섯 이미지를 실제 push하고 digest로 다시 pull했다. 여섯 게시 digest가 원래 검증 ID와 모두 일치했다. Mac 포트에만 연결한 첫 시도는 VM에서 연결되지 않아 실패했고, VM 내부 루프백으로 경로를 바로잡은 뒤 통과했다. 레지스트리 컨테이너와 해당 태그는 정리했다.
- 루트 최종 검토에서 일반 게시 증거 형식명을 바로잡았다. 관련 스크립트 **16개 통과**, 게시 CLI fixture의 세 output·검증 ID·새 증거 형식·재빌드 없음 확인, 변경 파일 lint·문법·diff 검사 통과. fixture의 Docker 경계는 모의 실행이며 위 실제 레지스트리 검증과 구분한다.
- GitHub Actions dispatch·GHCR 게시·운영 배포·커밋·push는 수행하지 않았다. 로컬 이미지의 revision 라벨은 기준 HEAD이고 내용은 수정한 작업 트리이므로 커밋된 릴리스의 증거로 쓰지 않는다. macOS 복원 검사의 Gateway는 호스트 소스이며 Admin·백업·복원 도구는 기록된 Linux 이미지다. 원격 Actions 권한과 Linux Gateway 복원 경로는 로컬 통과만으로 입증하지 않는다.
- 최초 공간 부족 때는 세 턴 연속 차단을 확인해 Goal을 blocked로 기록했다. 재개 후 위에 남겨 두었던 U4와 통합 검사까지 완료했으며, 사용자 기존 분석 문서는 수정하지 않았다.
- 정리된 증거의 notice·restore·archive·게시 ID가 서로 일치하는지 마지막으로 교차 검사했다. 이번에 생성한 여섯 검증 이미지 태그·일회용 registry 이미지 태그·대용량 archive·임시 Docker 설정을 정리했다. 사용자 기존 이미지·컨테이너·볼륨과 공유 빌드 캐시는 삭제하지 않았다. 작업 변경은 `main`의 로컬 미커밋 상태이며 staged 변경은 없다.

다음 업데이트 순서: 실제 운영 서버의 worker/release 상태 확인 → 승인된 첫 릴리스의 원격 CI·배포 검증 → 다음 schema 변경 전 U5의 이전 코드/새 schema 호환 계약 → 파일럿에서 확인된 사용성 문제. 일괄 major 갱신과 대형 재설계는 이번 완료 범위에 추가하지 않는다.

공식 수정 버전 근거: [Next 16.3.8](https://github.com/vercel/next.js/releases/tag/v16.3.8), [sharp 0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5), [source-map-js 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2). 이미지 전달 계약은 [Docker save](https://docs.docker.com/reference/cli/docker/image/save/), [Docker load](https://docs.docker.com/reference/cli/docker/image/load/), [gh run download](https://cli.github.com/manual/gh_run_download)를 확인했다.
