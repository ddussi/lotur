# Contributor roadmap

The current alpha is intended for a small team whose members trust each other. Content access remains deployment-wide, and one Gateway owns its live tunnel routes. This is a list of proposed follow-up scopes, not a claim that corresponding GitHub issues or assignments already exist. Use [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and review expectations.

## Small contributions

| Scope | A useful completed contribution |
| --- | --- |
| First-use documentation | Follow the [local demo](local-demo.en.md) from a fresh checkout, record OS/tool versions, and correct one reproducible setup problem in both English and Korean. Keep credentials and machine paths out of the report. |
| Synthetic examples | Add a focused route or layout variation to the Vite example, with stable `data-review-id` anchors. Demonstrate that a pin follows the intended element and that navigation keeps reviews on the correct path. |
| Keyboard usability | Reproduce one keyboard or focus problem in the review panel/inbox, describe expected behavior, and include a focused browser regression if changing behavior. |
| Framework compatibility | Reproduce a problem with a named Vite/Next version in a disposable consumer using the packed integration. Check live updates and that the production build excludes review scripts before expanding the support matrix. |

Small fixes can go directly to a pull request. A new feature or dependency should first have an agreed scope. Do not weaken authentication or substitute skipped checks to make a fixture pass.

## Larger follow-up work

| Area | Design needed before implementation |
| --- | --- |
| Project membership and invitations | Define project owner/member roles, inheritance, revocation, notification recipients and migration of existing deployment-wide access. This is required before serving mutually untrusted teams from one installation. |
| Drafts across tabs or devices | Same-tab reload recovery now uses session storage with login/project/revision isolation and a 12-hour expiry. Cross-tab or server-backed sync still needs conflict handling, retention and access design. |
| Multiple Gateways | Define route ownership, reconnect routing, shared limits and failure handling. Shared PostgreSQL does not make active tunnels portable between instances. |
| External notifications | Define opt-in destinations, credentials, recipient authorization and retry/duplicate rules. Current notifications stay inside the product. |
| Review attachments and edit history | Define retention, storage/access limits and deletion semantics before adding screenshot uploads or full edit history. |

These items have no promised schedule. The alpha preparation and publication gates are tracked separately in the [release plan](open-source-alpha-plan.md).

## 한국어 안내

작은 기여는 처음 설치 안내의 재현 가능한 오류 수정, 가상 데이터 예제의 화면·경로 추가, 키보드 사용성 개선, 특정 Vite·Next 버전의 연동 문제 확인부터 시작할 수 있습니다. 문서는 양 언어를 맞추고, 동작을 바꾸면 해당 문제를 확인하는 검사를 포함합니다. 실제 이슈나 담당자가 이미 정해졌다는 뜻은 아니므로 먼저 진행 중인 작업을 확인해 주세요.

프로젝트별 멤버·초대·접근 권한, 탭·기기 간 초안 동기화, 여러 Gateway 운영, 외부 알림, 스크린샷 첨부와 전체 편집 이력은 별도 설계가 필요한 후속 범위입니다. 같은 탭의 새로고침 후 초안 복구는 로그인·프로젝트·버전별 탭 저장소와 12시간 만료로 구현했습니다. 서로 신뢰하지 않는 팀을 같은 서버에 수용하려면 프로젝트 접근 제어가 먼저 필요합니다. 일정은 확정하지 않았습니다.
