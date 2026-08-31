# Security policy

## Project status

Review Tunnel is an alpha. Security fixes target the current development line; there is no published long-term support schedule or guaranteed response time. Operators are responsible for their own Gateway, DNS/TLS, account issuance, updates, and backups.

## Report a vulnerability privately

On the repository hosting your copy, use **Security → Report a vulnerability** if private vulnerability reporting is enabled. If there is no private reporting option, open an issue titled **Private security contact requested** with no exploit details and ask the maintainers for a private channel. This document does not imply that a reporting feature has already been enabled on a particular repository.

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

현재 개발자·검토자의 화면 접근 권한은 서버 전체에 적용됩니다. 프로젝트별로 사람을 구분해 접근시키는 기능은 아직 없습니다. 세션 종료 후 새 로그인은 가능하며, 지속 차단은 계정 정지나 권한 제거로 처리합니다. 실제 서비스 운영은 설치자의 DNS·HTTPS·백업·계정 관리와 함께 검증해야 합니다.
