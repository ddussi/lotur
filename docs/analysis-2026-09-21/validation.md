# 분석 검증 기록

분석일: 2026-09-20–21 KST. 이 문서는 제품을 수정한 결과가 아니라, 분석 기준 코드에서 실제로 수행한 검사와 한계를 기록한다.

## 기준과 원격 상태

- 작업 디렉터리의 브랜치: `main`.
- 로컬 HEAD: `ec39bc32a2fc362addbee7151365e03bf3a4707b`, 시작 시 작업 트리·스테이징 깨끗함.
- `git fetch origin` 성공 후 원격 HEAD: `5bfb322a222ca34d31b68bb4e0eb1f3cf788e805`.
- `git rev-list --left-right --count HEAD...origin/main`: `0 30`.
- 최신 커밋을 `git archive`로 격리 추출하고 그 사본에 의존성 설치·빌드·검사를 수행했다. 로컬 checkout을 통합하거나 전환하지 않았다.
- 빌드와 테스트 후 추적 파일 340개의 Git blob hash를 기준 커밋과 비교했다. **340개 모두 일치**했다. 생성물도 원본 커밋과 같았다.
- GitHub API 조회: 저장소 `public`, Release 목록 빈 배열, 설명·홈페이지 `null`.
- [최신 SHA CI](https://github.com/ddussi/lotur/actions/runs/34551152383): `verification`의 `Run npm run check:mvp` 실패. 뒤의 publish/deploy job은 실행되지 않았다. 실행 생성 시각은 `2026-09-11T01:33:33Z`이며 이번에 새 CI를 시작한 것이 아니다.

## 실제 환경

| 항목 | 이번 검증값 |
| --- | --- |
| OS/CPU | Darwin / arm64 |
| 고정 Node | 24.13.0 |
| npm | 11.6.2 |
| PostgreSQL | 17.6, Debian 17.6-2.pgdg12+1, 분석 전용 임시 컨테이너 |
| Docker Engine | 29.2.0 |
| Chrome | 153.0.8010.48 |
| Playwright | 1.62.1 |
| TypeScript | 5.9.3 |
| Vite / Next.js | 8.2.2 / 16.3.3 |

PostgreSQL 17.11 digest는 저장소에 정상 고정되어 있다. 이번 다운로드 프로세스는 수분 동안 `Pulling` 이후 진전이 없어 종료했고, 이미 설치된 17.6으로 독립 fixture를 띄웠다. 따라서 이번 결과는 **17.11 재검증이 아니다**. 기존 운영 DB나 다른 프로젝트의 DB를 사용하지 않았다. 임시 DB는 기존 `compose.test.yml`에 이미지 override만 적용했고 데이터는 tmpfs다.

초기 셸의 `node --version`은 24였지만 자식 프로세스가 PATH에서 Homebrew Node 26.0.0을 선택했다. `process.execPath`와 실제 자식 프로세스로 차이를 확인한 뒤 PATH를 Node 24로 고정했다. 아래 최종 앱/스크립트/브라우저 결과는 부모와 자식이 모두 24.13.0인 상태다.

## 명령과 결과

각 명령은 최신 원격 사본에서 실행했다. `TEST_DATABASE_URL`은 소스 Compose에 명시된 분석용 합성 계정과 loopback 포트를 사용했다. 운영 자격증명은 사용하지 않았다.

| 검사 | 실제 결과 | 해석 |
| --- | --- | --- |
| `npm ci` | 설치 완료, 설치 시 감사 0건 | 네트워크 제한 때문에 승인된 재실행 필요 |
| `npm run check` 중 style | 종료 코드 0, 231개 파일, warning 1·info 49 | 경고 없는 상태는 아님 |
| 위 명령 중 typecheck | 통과 | TypeScript 검사 대상에 한정 |
| 위 명령 중 boundaries | 통과 | 정해 둔 의존성 규칙 범위 |
| 위 명령 중 build | Gateway/Client·리뷰 UI·Vite/Next 빌드 통과 | 산출물의 운영 실행 전체를 증명하지 않음 |
| `npm run test:scripts` | Node 24 최종 79/79, 실패·skip 0 | 포트 3000의 기존 리스너에 의존한 테스트가 있어 CI 독립성 결함은 남음 |
| `TEST_DATABASE_URL=<isolated> npm test` | Node 24 최종 367/367, 실패·skip 0 | 실제 PG 17.6 integration 포함 |
| `npm run test:frameworks` | Node 24 최종 22/22, 약 34.3초 | Chrome·로컬 HTTP·fixture 조건 |
| `npm run check:release-version` | 통과, 14개 패키지와 Docker runtime 버전 일치 | 실제 Release 게시를 확인하는 검사는 아님 |
| `npm audit --omit=dev --json` | info/low/moderate/high/critical 모두 0 | npm 운영 의존성의 알려진 advisory 범위 |
| 기준 SHA와 파일 hash 대조 | 340개 모두 일치 | 분석 중 제품 소스를 바꾸지 않았음 |

서로 다른 최종 자동 검사 수는 79 + 367 + 22 = **468개**다. Python 배포 검사 24개는 script 테스트가 호출한 내부 검사라 별도로 합산하지 않는다. 반복 실행한 브라우저/스크립트 검사도 다시 더하지 않는다.

**전체 릴리스 gate 통과로 표현하지 않는다.** `npm run check` 최초 실행은 sandbox의 로컬 통신 제한으로 script 단계에서 종료했고, 실패한 부분은 허용된 환경에서 나누어 재실행했다. 최신 GitHub CI는 여전히 실패다. 로컬의 468개 통과도 외부 포트 의존을 해소하지 않는다.

### 실패·중단을 보존한 기록

1. 최초 `git fetch`: `.git/FETCH_HEAD` 쓰기 제한. 승인된 재실행은 성공했다.
2. 최초 `npm ci`: registry DNS `ENOTFOUND`. 종료 후 승인된 재실행은 성공했다.
3. 최초 script 검사: 76/79, 실패 3. 두 개는 localhost listen `EPERM`, 하나는 포트 probe가 실패해 TTY 오류 기대와 불일치. 허용된 실행에서는 79/79였으나 세 번째 테스트의 환경 의존성은 원격 CI 로그와 대조해 결함으로 확정했다.
4. 초기 Node 26.0.0 앱 검사: `http-tunnel.test.ts`의 `early chunked responses finish after upload END while downstream is waiting for drain`에서 10초 timeout과 후속 cancel 실패. 프로세스가 남아 이번 작업이 시작한 해당 프로세스만 종료했다. Node 24의 동일 전체 검사는 통과했다. 이 결과만으로 Node 26 전체 지원 불가나 제품 장애라고 확정하지 않는다.
5. PG 17.11 pull: 관측상 진전 없는 실행을 종료하고 17.6으로 한계를 명시해 진행했다.

## 범위별 검토

| 영역 | 검토 방식 |
| --- | --- |
| Client·Gateway transport, protocol/relay/proxy/operations/cli-utils | 진입점·상태 전이·자원 소유권·오류/취소·재연결·관련 테스트 정적 추적, 메타데이터 경계 재현 |
| auth/review/storage-postgres, Gateway 인증·리뷰 API·UI | 서비스/저장소 계약, 트랜잭션·상태 전이·권한·초안·갱신 코드 및 테스트, DB와 경로·페이지 경계 재현 |
| admin-cli, Vite/Next integration, scripts/tests/deploy/CI | 포장·실행·배포·복원 경로와 문서 대조, 구성 경계 재현, 공식 지원정책 확인 |
| 문서·ADR·README·기존 검증 기록 | 현행 기능과 과거 계획 분리, 제품 범위·불변식·완료 조건·공개 상태 대조 |
| manifest/lockfile·생성 bundle | 의존성/버전 검사·감사, 원본 소스/빌드와 동일성 확인 |
| PNG 3개 | 저장소에 포함된 실제 예제 캡처의 시각 확인 |
| WebM 1개 | 파일 목록·설명·촬영 코드 확인. 영상 전체 재생 검수는 수행하지 않음 |

파일 목록·Git blob·검토 분류는 [inventory.json](inventory.json)에 있다. 이 목록은 전 파일의 모든 실행 경로가 검증됐다는 증명서가 아니다. 외부 의존성의 모든 소스나 OS·컨테이너 계층의 전체 보안 검토도 포함하지 않는다.

구현은 핵심 흐름과 외부 경계 중심으로, 테스트는 전체 목록 탐색 후 계약·회귀와 관련된 본문을 선별해 읽었다. 모든 테스트의 모든 행을 독립 정독한 것은 아니다. 긴 브라우저·문서 contract 테스트, Gateway 설정은 주요 경로와 검증 경계 위주로 확인했다.

## 별도 재현 기록

아래 기록은 기존 테스트가 통과해도 놓칠 수 있는 경계를 확인하기 위한 것이다. 제품 코드를 수정하지 않았고 합성 계정·댓글·loopback 서버만 사용했다. 구체적 결과와 코드 근거는 종합 보고서의 F 항목을 따른다.

### F02: 삭제 후 답글의 저장소 계약

Node 24.13.0, 분석 전용 PG 17.6에서 임의 이름의 격리 schema를 만들고 실제 auth/review migration을 실행했다. 합성 개발자·검토자 계정으로 같은 `createReviewService`에 메모리 저장소와 PG 저장소를 각각 주입했다. 프로젝트 연결→댓글 생성→작성자 삭제→개발자 답글 생성 순서의 실제 결과는 다음과 같다.

```json
{
  "memory": { "outcome": "STATE_CONFLICT" },
  "postgres": { "outcome": "CREATED", "replyBody": "Posted after deletion" },
  "stored": [{ "thread_body": null, "thread_deleted": true, "reply_body": "Posted after deletion" }]
}
```

서비스 반환값과 DB 조회를 모두 확인했고 생성한 schema는 `finally`에서 제거했다. 원래 테스트 367개 통과와 양립하는 누락된 경계 사례다. 경합 실행은 이번 재현에 포함하지 않았으므로 수정 시 추가 검증 조건으로 남겼다.

### F03: 응답 헤더 오류의 전송 장애 범위

최신 snapshot의 실제 `connectTunnelClient`와 `createGatewayServer`를 사용했다. Node 24.13.0에서 `127.0.0.1:0` origin을 띄워 `/held`는 열린 SSE, `/large-headers`는 257개의 `x-test-*` 헤더와 짧은 body를 반환하게 했다. Client 활성화→SSE 첫 데이터 수신→헤더 초과 요청 순서의 결과다.

```json
{
  "responseStatus": 503,
  "responseBody": "{\"error\":\"TUNNEL_OFFLINE\"}",
  "heldDestroyed": true,
  "closedReason": "failed",
  "closedError": "Carrier closed with WebSocket code 1002: protocol error",
  "protocolErrorReason": "header list is invalid"
}
```

재현 프로세스는 종료 코드 0으로 끝났고 자신이 만든 Client·Gateway·origin을 정리했다. 무인증 loopback fixture로 전송 계층의 결과를 확인한 것이며 운영 인증형 HTTPS 전체를 실행한 결과는 아니다. 같은 코드 경로의 장애 격리 문제는 확정했지만 실제 발생 빈도는 측정하지 않았다.

### F04: 경로 검증과 URL 해석

실제 `normalizeRoutePath('/\\example.invalid/landing')`의 통과와 `new URL(path, 'https://share.example.test').href`가 `https://example.invalid/landing`이 되는 것을 Node 24에서 확인했다. 문자열 표기에서 `\\`는 역슬래시 한 문자다. focus HTTP 처리 코드가 이 경로를 그대로 브라우저 `location.replace`로 전달하는 것도 정적으로 확인했다. 이 재현 단계는 실제 계정의 HTTP 요청이나 외부 사이트 접속을 수행하지 않았다.

### F05: 필터 기준점 소멸 시 페이지 증가

실제 `refreshLoadedPage`에 합성 페이지 API를 주입했다. 현재 목록은 ID 901–1000의 100개, 변경 뒤 OPEN 결과는 1–1001 중 해결된 ID 901을 뺀 1,000개, 페이지 크기는 100으로 두었다.

```json
{"initialLoaded":100,"remainingTotal":1000,"pageRequests":10,"refreshedLoaded":1000}
```

API의 페이지 경계와 호출 수를 확인한 단위 수준 재현이다. 실제 PostgreSQL 쿼리 시간·브라우저 메모리 수치를 측정한 것으로 해석하지 않는다.

### F06: 배포 Control 포트 검사

기존 `scripts/test_deployment.py`의 `DeploymentTests` fixture를 준비하고 `controlUrl`과 `CONTROL_HOST`에 같은 8443 포트를 추가했다. 실제 `load_configuration`은 `Control origin does not match gateway.env` 예외를 반환했다. 임시 파일과 FakeDocker만 사용했고 Docker·SSH·운영 환경에 명령을 보내지 않았다. 생성한 임시 디렉터리는 fixture cleanup으로 제거했다.

### F07·F08: 프로토콜과 헤더 변환의 순수 함수 계약

Node 24.13.0에서 실제 `decodeConnectionErrorMetadata(encodeMetadata({code: 'RELAY_NOT_READY', retryAfterMs: 1000}))`는 `CONNECTION_ERROR retryAfterMs is invalid` 예외를 던졌다. Gateway의 동일 조합 송신 코드와 대조했다. 수용량을 가득 채운 실제 연결 재현은 수행하지 않았다.

실제 `headerPairsToOutgoingHeaders([['constructor', 'value'], ['__proto__', 'value']])` 결과에서 `constructor` 배열 원소의 타입은 `function`, `string`이었고 첫 값은 Object 생성자였다. `Object.hasOwn(output, '__proto__')`는 false, 반환 객체의 prototype은 배열이었다. 새 일반 객체의 prototype은 그대로 `Object.prototype`이므로 전역 prototype 오염으로 보고하지 않았다. HTTP 왕복의 추가 영향은 미검증이다.

## 실행하지 않은 검사

- 운영 서버·실제 DNS/TLS/Ingress의 최신 커밋 인수와 실제 사용자 파일럿.
- 이번 커밋의 여섯 Docker runtime 전체 재빌드, 이미지별 기능·백업/복원, candidate/version 이미지 게시.
- 신규 데모·독립 Client의 터미널/재시작 E2E 전체(`test:demo`) 및 이미지 기반 `test:restore`.
- PostgreSQL 17.11·15/16/18 전체 매트릭스, Windows·Firefox·Safari, 스크린리더.
- 장기 soak·최대 용량·다중 Gateway·실제 네트워크 단절의 전체 조합.
- Git 이력·공개 Actions 로그 전체의 비밀정보 감사. 이번에는 최신 CI 실패 원인 확인에 필요한 로그만 읽었다.

이 항목들은 분석 Goal의 범위를 숨기지 않기 위한 한계다. 해당 환경의 구현 완료·지원 보장을 주장하려면 각 범위의 추가 검증이 필요하다.

## 외부 근거

웹 확인일은 2026-09-20–21 KST다. 공식 자료는 권고를 보조하며 이 프로젝트의 실행 결과를 대신하지 않는다.

| 출처 | 적용한 판단 |
| --- | --- |
| [Node 릴리스 정책](https://nodejs.org/en/about/previous-releases) | 24 LTS 유지, 지원 범위와 실제 runtime 고정 |
| [Next.js 지원 정책](https://nextjs.org/support-policy) | 16 Active LTS, patch와 실제 framework 회귀를 함께 확인 |
| [Vite releases](https://vite.dev/releases) | 8.2 지원을 EOL로 오판하지 않고 8.3 업데이트 검토 |
| [PostgreSQL versioning](https://www.postgresql.org/support/versioning/) | 17.11 현재 minor, major 교체와 minor 갱신 구분 |
| [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) | sequence와 transaction visibility 구분, 이벤트 순서 설계 평가 |
| [ngrok localhost](https://ngrok.com/use-cases/share-localhost) | 공유 기능만으로 차별성을 주장하지 않음 |
| [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) | 기존 터널 제품과 운영·네트워크 범위를 비교 |
| [Vercel Comments](https://vercel.com/docs/comments) · [Local Toolbar](https://vercel.com/docs/vercel-toolbar/in-production-and-localhost) | 로컬 리뷰가 독점적 기능이라는 가정을 배제 |
| [Google SRE SLO](https://sre.google/workbook/implementing-slos/) | 사용자 흐름·성공 사건/전체 사건·지연 측정 정의 |
| [W3C keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) | 키보드·초점 관리의 실제 검증 계획 |
| [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) | 비밀번호 차단 목록의 후속 강화 제안. 준수 의무·인증 취득 여부는 주장하지 않음 |
| [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations) · [SLSA provenance](https://slsa.dev/spec/v1.2/provenance) | 소스 SHA와 실제 배포물 digest의 증거 연결. attestation이 기능 테스트를 대신하지 않음 |

## 변경·정리

로컬 저장소에는 이 분석 폴더만 추가했다. 원래 소스·설정·테스트·README, 사용자 변경을 덮어쓰지 않았다. 커밋·push·태그·릴리스·운영 배포는 수행하지 않았다. 분석에 사용한 사본과 임시 로그는 작업용 자료이며 최종 판단은 이 문서와 종합 보고서에 보존한다.

검증 종료 후 이번 작업이 만든 `lotur-analysis-20260920-postgres-1` 컨테이너와 전용 네트워크를 Compose로 제거했고 해당 이름의 실행 컨테이너가 없음을 확인했다. 다른 프로젝트의 컨테이너·볼륨과 기존 포트 3000 서버는 유지했다.

최종 교차검토에서 정상적인 조건부 CI skip과 필수 검증 누락, 과거 문서와 현재 구현, 정적 분석과 실행 재현을 구분했다. 문서 링크 63개의 로컬 대상·고정 SHA 경로·행 번호 범위를 확인했고 누락은 없었다. 이 검사는 모든 외부 웹사이트의 HTTP 가용성 검사와는 다르다. Markdown 코드 블록·미완성 표시·줄 끝 공백도 확인했다. 마지막 제품 파일 hash 340개는 다시 모두 일치했고 로컬 작업 트리의 추가 항목은 분석 폴더뿐이었다.
