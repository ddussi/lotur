# ADR-0005: 인증형 Gateway와 로컬 네트워크 공유를 독립 모드로 제공

- 상태: 승인
- 날짜: 2026-08-25

## 배경

Review Tunnel의 기능은 로컬 웹 애플리케이션을 다른 기기의 브라우저에 임시 공유하는 것이다. 사용 장소나 운영 주체의 형태는 제품 기능의 전제가 아니다. 다만 도메인과 운영 서버를 준비할 수 있는 경우와 준비하지 않는 경우는 필요한 보안 경계와 네트워크 흐름이 다르다.

## 결정

두 모드를 서로 독립적으로 제공한다.

### 인증형 Gateway 모드

- 하나의 기준 도메인 아래에 콘텐츠 wildcard host와 그 바깥의 control host를 구성한다.
- Gateway는 Linux 서버 또는 컨테이너 환경에서 실행한다.
- PostgreSQL, TLS, 관리자 발급 계정, 배포 canary와 admission을 사용한다.
- Client는 Gateway에 아웃바운드 WSS Carrier를 만들며 개발자 컴퓨터에 외부 listener를 열지 않는다.
- 어떤 기준 도메인과 인프라를 사용할지는 운영자가 결정한다. Review Tunnel은 host·wildcard·TLS·Cookie에 필요한 기술적 불변식만 검증한다.

### 로컬 네트워크 모드

- 개발자 컴퓨터에서 임시 Gateway와 Client를 함께 실행한다.
- Gateway는 선택한 RFC 1918 사설 IPv4에 HTTP와 WebSocket listener를 연다.
- 공유 URL의 서명된 bootstrap 경로로 host-only route Cookie를 설정하고 이후 앱 경로를 그대로 유지한다.
- 계정, PostgreSQL, DNS와 TLS를 사용하지 않는다.
- Wi-Fi 이름이나 서브넷을 검증하지 않으므로 선택한 IP와 포트에 접근할 수 있는 신뢰된 네트워크에서만 사용한다.

## 결과

사용자는 인프라 보유 여부에 따라 모드를 선택할 수 있고, 제품 문서와 핵심 요구사항은 특정 운영 주체나 장소를 전제로 하지 않는다. 인증형 보안 정책을 로컬 네트워크 모드에 억지로 적용하거나 로컬 모드의 무인증 동작이 인증형 Gateway로 섞이지 않도록 설정과 실행 진입점을 분리한다.
