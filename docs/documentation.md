# Documentation / 문서 안내

Start with the current guides below. Dated plans and validation reports describe their recorded revision and are kept separately as historical evidence.

아래 사용 안내는 현재 구현을 설명합니다. 날짜가 있는 계획·검증 문서는 당시 기준 버전의 기록이며, 현재 설치 방법과 구분합니다.

## Use Review Tunnel / 사용하기

| Purpose / 목적 | English | 한국어 |
| --- | --- | --- |
| Overview / 제품 소개 | [README](../README.md) | [README](../README.ko.md) |
| Local demo / 로컬 체험 | [Demo walkthrough](local-demo.en.md) | [체험 안내](local-demo.md) |
| Install only the Client / Client만 설치 | [Client archive](client-installation.en.md) | [독립 Client 설치](client-installation.md) |
| Share and configure reviews / 공유·연동 설정 | [Getting started](getting-started.en.md) | [시작 안내](getting-started.md) |
| Pins, inbox, notifications, re-review / 리뷰 사용 | [Review guide](review-guide.en.md) | [리뷰 안내](internal-review-guide.md) |
| Boundaries and security reports / 권한·보안 제보 | [Security policy](../SECURITY.md) | [보안 안내](../SECURITY.md#한국어-안내) |
| Changes / 변경 사항 | [Changelog](../CHANGELOG.md) | [현재 구현 현황](poc-status.md) |

The local demo and archive builder run from a source checkout. A developer can install the resulting standalone Client archive without the repository. Tagged release downloads are still being prepared.

로컬 체험과 설치 파일 생성은 소스 checkout에서 실행합니다. 생성한 독립 Client 파일은 저장소 없이 설치할 수 있습니다. 태그 릴리스 다운로드는 준비 중입니다.

## Operate and contribute / 운영·기여

- [Gateway setup (English)](getting-started.en.md#install-a-gateway-prerequisites) · [Gateway 운영 설정](getting-started.md#인증형-gateway-운영)
- [Linux 운영·백업·복원](linux-deployment.md)
- [GitHub Actions 자동 배포](automatic-deployment.md)
- [계정 운영](internal-account-operations.md)
- [Public HTTPS verification / HTTPS 검증](public-path-testing.md)
- [Contributing / 기여](../CONTRIBUTING.md) · [Release procedure / 릴리스 절차](releasing.md)
- [오픈소스 알파 실행 계획](open-source-alpha-plan.md)

Detailed operations runbooks are currently in Korean; the English getting-started guide covers Gateway initialization. The alpha preparation plan tracks the remaining release and onboarding work.

## Historical records / 과거 기록

- [서버 구조·리뷰 기능 통합과 DB 변경 — 2026-09-08](integration-2026-09-08.md)
- [통합 전 리뷰 기능 계획](review-improvement-plan-2026-09-07.md) · [당시 구현·검증](review-improvement-progress.md)
- [서버 구조 개선 목표](improvement-goal-2026-09-07.md) · [당시 결과](architecture-review-2026-09-07.md)
- [통합 전 전체 구현 상태 — 2026-09-07](validation/implementation-2026-09-07.md)
- [초기 HTTPS 공유·인증 검사](validation/public-https-2026-09-06.md)
- [로그인 화면 개선 계획](login-ui-improvement-plan-2026-09-08.md) — planned design, not an implemented redesign / 미구현 디자인 계획
- [ADR 목록](adr/) — accepted and superseded decisions retain their recorded status / 승인·철회 상태를 보존한 설계 결정
