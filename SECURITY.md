# Security policy

## Project status

Review Tunnel is an alpha. Security fixes target the current development line; there is no published long-term support schedule or guaranteed response time. Operators are responsible for their own Gateway, DNS/TLS, account issuance, updates, and backups.

The first planned release is `v0.1.0-alpha.1`; it has not been published. After publication, fixes will target the latest alpha release. Older alpha snapshots have no promised backport support. Upgrade using the source commit, installable archives and immutable image references supplied with the official release; compare its checksum manifest and read its migration/rollback notes before replacing an installation. Until a release exists, use the documented source build and [Client archive procedure](docs/client-installation.en.md), not an assumed npm registry package.

## Report a vulnerability privately

For the official `ddussi/lotur` repository, **Security → Report a vulnerability** will be enabled and verified as part of first publication. During the current private preparation, there is no public reporting channel, and this document does not claim that the feature is already active. Publication requires updating this paragraph with the verified reporting link.

On a fork or another hosting repository, check its own Security tab and maintainer policy. If there is no private reporting option, open an issue titled **Private security contact requested** with no exploit details and ask the maintainers for a private channel. Never place a reproduction of a security vulnerability in that public request.

In the private report, include the affected commit or version, impact, prerequisites, a minimal reproduction against an installation you control, and any proposed fix. Use synthetic accounts and data. Exclude real passwords, tokens, cookies, account exports, private domains, and unrelated user data.

Coordinate disclosure with the maintainers before publishing details that could expose active installations. Ordinary non-security bugs can use the regular issue template.

## Current trust boundaries

- `ADMIN`, `DEVELOPER`, and `REVIEWER` are independent roles; administration alone does not grant content access.
- `DEVELOPER` and `REVIEWER` content authorization is deployment-wide. Either role can access another valid share URL. Review records are grouped by owner/project/revision/path, but this is not a project membership access list. Any developer with access can resolve/reopen or delete review content; binding a project to a tunnel requires ownership of that tunnel.
- A Client shares the complete loopback HTTP origin, including routes offered by the local app. The app's own authentication and authorization still matter. Browser calls to other localhost ports are not automatically tunneled.
- Login sessions use host-only cookies. A parent domain's unrelated `Domain` cookies may still reach preview hosts; choose domain boundaries accordingly.
- TLS termination, forwarding-header sanitization, streaming behavior, and the exact trusted proxy CIDRs are part of each deployment's configuration. Do not expose the loopback development mode as an authenticated hosted service.
- Session revocation invalidates current login artifacts. Persistent denial requires disabling the account or removing the relevant role. Checks propagate periodically, with a default 5-second revocation check interval.
- Active tunnels are in Gateway memory. PostgreSQL persists accounts, review data, and operational controls, not live routes across Gateway restarts or replicas.
- Public-path checks use a separate bearer-protected synthetic host. Never substitute a customer's application or credentials for the canary.

These are the documented alpha boundaries, not a claim of independent security certification. The [implementation status](docs/poc-status.md) and [validation report](docs/validation/public-https-2026-09-06.md) distinguish tested behavior from outstanding operational verification.

## 한국어 안내

취약점은 저장소의 비공개 제보 기능을 사용해 주세요. 기능이 없다면 상세 재현 내용 없이 **Private security contact requested**라는 이슈로 비공개 연락 방법을 요청합니다. 실제 계정·토큰·개인 도메인·사용자 데이터는 첨부하지 않습니다.

첫 예정 버전은 `v0.1.0-alpha.1`이며 아직 게시하지 않았습니다. 현재는 비공개 준비 단계이고 공개 제보 경로도 아직 활성화하지 않았습니다. 최초 공개 때 공식 저장소의 비공개 제보 기능과 실제 링크를 확인해 이 문서를 갱신합니다. 공개 이후 보안 수정 대상은 최신 알파이며 이전 알파의 별도 수정 지원이나 응답 시간을 약속하지 않습니다. 업데이트할 때 릴리스의 커밋·체크섬·이미지 digest와 DB 변경 안내를 함께 확인합니다.

현재 개발자·검토자의 화면 접근 권한은 서버 전체에 적용됩니다. 프로젝트별로 사람을 구분해 접근시키는 기능은 아직 없습니다. 세션 종료 후 새 로그인은 가능하며, 지속 차단은 계정 정지나 권한 제거로 처리합니다. 실제 서비스 운영은 설치자의 DNS·HTTPS·백업·계정 관리와 함께 검증해야 합니다.
