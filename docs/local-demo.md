# 내 컴퓨터에서 리뷰 체험하기

[English](local-demo.en.md) · [제품 소개](../README.ko.md)

작은 Vite 앱, Gateway, Client, 전용 PostgreSQL을 내 컴퓨터에서 함께 실행한다. 자동으로 만든 개발자·검토자 계정으로 핀·답글·알림·재검토를 체험할 수 있다. 출력되는 주소는 이 컴퓨터에서만 열린다.

## 시작

Node.js 24 이상, 실행 중인 **로컬 Docker Engine 28 이상**과 Docker Compose, Google Chrome을 준비한다. 내려받은 저장소 루트에서 실행한다.

```sh
npm ci
npm run demo
```

처음에는 고정된 PostgreSQL 이미지가 없으면 내려받는다. 실행기는 실제 DB 변경을 적용하고 계정을 만든 뒤, 로컬 인증·스트리밍 검사를 통과한 이 데모의 공유를 승인하고 예제 앱을 시작한다. 별도 도메인·인증서·시스템 hosts 파일 수정은 필요 없다.

**Demo ready**가 나오면 터미널을 그대로 두고, **Shared app** 주소를 Chrome에서 연다. 다른 터미널에서 로컬 계정 정보를 확인한다.

```sh
npm run demo -- credentials
```

일반 Chrome 창은 `reviewer`, 시크릿 창이나 별도 프로필은 `developer`로 로그인한다. 각 계정의 비밀번호는 별도로 무작위 생성된다. 같은 프로필의 두 탭은 로그인을 공유하므로 두 사용자 체험에는 별도 프로필이 필요하다. 초기 비밀번호 변경은 데모 준비 과정에서 끝난다.

계정·설정은 Git에서 제외된 `.review-tunnel-demo/`에 비공개 파일 권한으로 저장된다. 시작 명령은 비밀번호 대신 계정 파일 위치를 출력한다. `credentials` 명령은 로컬 비밀번호를 의도적으로 보여 주므로 출력 내용을 버그 제보에 포함하지 않는다.

## 리뷰 한 사이클 체험

1. `reviewer`로 공유 앱에서 **Select area or pin**을 누르고 프로젝트 카드 일부를 드래그한다. `@developer Please check this spacing.`을 적고 **Comment**로 등록한다.
2. 리뷰 창을 닫고 **Try compact layout**을 누른다. 카드 크기가 바뀌어도 핀이 따라간다. 리뷰 창을 다시 열어 상태 필터를 바꾸고 댓글의 **Permanent link**를 복사한다.
3. `developer`로 영구 링크를 연다. 알림함을 펼쳐 멘션을 확인하고, 답글을 남긴 뒤 **Request review**를 누른다.
4. `reviewer`로 같은 영구 링크를 열어 답글·알림을 확인한다. 추가 수정이 필요하면 **Request more changes**, 완료됐으면 **Confirm resolved**를 누른다. 양쪽에 상태 변경과 처리 이력이 반영된다.
5. 출력된 **Review inbox** 주소에서 저장된 피드백을 찾아본다. [예제 소스](../examples/vite-review/src/main.js)를 수정하면 Vite가 실행 중인 앱을 갱신한다.

리뷰는 `launch-checklist` 프로젝트와 `demo-v1` 버전에 저장된다. 예제 앱의 체크리스트는 화면 체험용 상태여서 새로고침하면 초기화된다. 제출한 리뷰는 PostgreSQL에 저장된다. 미제출 초안은 현재 탭에서 실시간 갱신·필터 변경 중 유지되지만, 새로고침하거나 탭을 닫으면 사라진다.

## 종료·재시작·삭제

데모 터미널에서 `Ctrl+C`를 누른다. 실행기가 시작한 Gateway·Client·예제 앱·DB 컨테이너를 멈추고, DB 볼륨과 계정 정보는 남긴다. 실행기가 멈춘 동안에는 리뷰함도 열리지 않는다.

다시 `npm run demo`를 실행하면 새 임시 공유 주소가 나온다. 기존 댓글·답글·알림·계정 비밀번호·영구 댓글 링크는 유지된다. 영구 링크를 열려면 Gateway가 실행 중이어야 한다.

**이 데모의 저장된 리뷰·계정·생성된 비밀번호를 삭제**하려면 먼저 실행을 멈추고 다음 명령을 사용한다.

```sh
npm run demo -- reset --confirm-delete-demo-data
```

해당 데모의 Compose 프로젝트 DB 볼륨과 생성 파일을 삭제한다. 예제 앱 소스는 유지한다. 다음 시작은 새 데모를 만든다.

## 포트와 문제 해결

기본 loopback 포트는 Gateway `8788`, Vite `5178`, PostgreSQL `54339`다. 사용 중이라면 처음 시작할 때 서로 다른 빈 포트 세 개를 지정한다.

```sh
npm run demo -- --state-dir .review-tunnel-demo/alternate \
  --gateway-port 8789 --app-port 5179 --database-port 54340
npm run demo -- credentials --state-dir .review-tunnel-demo/alternate
```

이후 시작·계정 확인·삭제에도 같은 `--state-dir`를 붙인다. 기존 체험의 포트 변경은 거부한다. 비어 있는 전용 디렉터리를 사용하고 Git에 포함하지 않는다.

| 증상 | 확인할 내용 |
| --- | --- |
| Docker 실행 실패 | 로컬 엔진을 켜고 `docker info`, `docker compose version`을 확인한다. 원격 Docker context는 사용하지 않는다. |
| 포트 사용 중 | 해당 서비스를 직접 멈추거나 다른 전용 디렉터리와 빈 포트 세 개로 시작한다. 실행기가 다른 프로세스를 종료하지 않는다. |
| 같은 상태 디렉터리를 사용 중 | 기존 데모 터미널에서 `Ctrl+C`로 멈춘다. 기록된 프로세스가 종료된 경우에만 다음 실행이 잠금을 회수한다. |
| 준비 중 오류 | 상태 디렉터리의 비공개 `runner.log`를 확인한다. 일반 오류에서는 소유 프로세스를 정리하고 데이터를 보존한다. 원인을 해결한 뒤 재실행한다. |
| 계정 생성 중 강제 종료 | 같은 상태 디렉터리로 재실행한다. 기록된 임시 비밀번호 변경을 이어서 처리하며 DB를 교체하지 않는다. |
| `.localhost` 주소가 열리지 않음 | Chrome을 사용하고 proxy·VPN의 loopback 처리를 확인한다. Node 프로세스에는 자체 이름 해석을 적용하며 시스템 DNS는 바꾸지 않는다. |

데모 HTTP는 loopback에서만 사용한다. 자식 프로세스에 운영 DB·Gateway 설정을 전달하지 않는다. 외부 DNS·TLS·다른 기기 접근은 별도 검증 대상이다. 팀에 공유하려면 [Gateway 운영 안내](getting-started.md#인증형-gateway-운영)를 따른다.
