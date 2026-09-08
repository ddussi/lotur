# Client만 별도로 설치하기

[English](client-installation.en.md) · [시작 안내](getting-started.md)

생성한 `.tgz` 파일로 Client만 설치할 수 있다. 사용하는 컴퓨터에는 Node.js 24 이상이 필요하며, 소스 저장소·서버 코드·PostgreSQL·개발 의존성은 필요 없다. 태그 릴리스와 npm 저장소 게시는 아직 없으므로, 아래는 현재 소스에서 로컬 설치 파일을 만드는 방법이다.

## 설치 파일 만들기

Review Tunnel 저장소 루트에서 실행한다.

```sh
npm ci
npm run pack:client
```

완료하면 설치 파일 경로를 출력한다. 현재 버전의 기본 경로는 `dist/releases/review-tunnel-client-0.1.0.tgz`다. 기존 파일을 덮어쓰지 않으므로 다시 만들 때는 `npm run pack:client -- --output-dir dist/releases/another-build`처럼 별도 출력 폴더를 지정한다.

파일에는 Client 코드, `review-tunnel` 명령, 버전을 고정한 필수 JavaScript 의존성 `ws`, 양쪽 라이선스가 들어간다. 설치 hook·선택적 native addon·Gateway·DB 드라이버는 포함하지 않는다. 실수로 npm 저장소에 게시하지 않도록 메타데이터는 private로 유지하며, 파일을 통한 설치는 가능하다.

## 개발자 컴퓨터에서 설치·실행

설치 파일을 사용할 컴퓨터로 복사한 뒤, 소스 저장소 밖의 전용 폴더에서 실행한다.

```sh
npm init -y
npm install --ignore-scripts /path/to/review-tunnel-client-0.1.0.tgz
npx --no-install review-tunnel --version
npx --no-install review-tunnel --help
```

`/path/to/…`는 실제 복사한 파일 경로로 바꾼다. 필수 런타임을 포함하므로 빈 npm 캐시와 `--offline` 옵션에서도 설치를 검증했다. 이 파일의 의존성을 받기 위한 온라인 npm 저장소는 필요 없다.

공유할 웹앱을 실행한 채로 다음 명령을 사용한다.

```sh
npx --no-install review-tunnel http://127.0.0.1:3000 \
  --gateway wss://control.tunnel.example.com/_review-tunnel/carrier \
  --username developer1 --review-project storefront --review-revision your-revision
```

도메인은 운영자에게 받은 주소로 바꾼다. 개발자 계정의 초기 비밀번호는 로그인 화면에서 먼저 변경해야 한다. 터미널 프롬프트에 비밀번호를 입력하면 화면에 표시하지 않는다. 자동 실행은 `--password-stdin`을 명시하고 비밀번호 한 줄만 표준 입력으로 전달한다. 비밀번호를 명령 인자로 받는 옵션은 없다.

해당 loopback origin 전체를 공유한다. 연결과 선택적 리뷰 설정이 성공한 뒤 주소를 출력하며, `Ctrl+C`로 종료한다. 연결이 끊겨도 Gateway의 재연결 유예 안에 복구하면 같은 주소를 유지한다. 앱의 핀·댓글 연동은 별도로 필요하며 [연동 설정](getting-started.md#vite와-nextjs-integration)을 따른다.

## 확인과 업데이트

새로 검증한 설치 파일을 같은 전용 폴더에 설치하고 `--version`으로 확인한다. 소스 실행·컴파일된 Docker 진입점·독립 파일은 같은 Client 메타데이터의 버전을 사용한다.

[소비자 검증 기록](validation/client-package-2026-09-09.md)에 저장소 밖 설치와 실제 Gateway 검사를 기록했다. 버전별 릴리스 다운로드·체크섬·업그레이드 보장은 별도 준비 중이다. 로컬에서 생성한 파일을 게시된 릴리스로 간주하지 않는다.
