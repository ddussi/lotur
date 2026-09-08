# 알파 업데이트와 DB 복원

[English](upgrading.en.md)

`v0.1.0-alpha.1`은 아직 게시하지 않은 후보입니다. 아래는 구현된 도구와 운영자가 확인할 절차입니다. [격리 DB 복원 검사](validation/database-restore-2026-09-09.md)는 macOS와 실제 Linux 이미지에서 통과했습니다. 최종 릴리스에는 선택한 최종 후보와 HTTPS·이전 이미지 호환성 검증이 추가로 필요하며 [알파 계획](open-source-alpha-plan.md)에서 관리합니다.

## 버전과 기존 상태 보관

현재 커밋, Gateway·Admin CLI·canary 이미지 digest, 배포 ID·설정 digest를 기록하고 설정·비밀 값·이전 이미지를 비공개로 보관합니다. DB dump에는 DNS·TLS 설정, HMAC 키, Docker 설정이나 실행 중인 공유 연결이 들어 있지 않습니다.

같은 성공한 후보 실행의 소스·설치 파일 manifest와 6개 이미지 기록을 선택해 버전·전체 커밋 SHA를 대조합니다. migration·실행·백업·복원은 기록된 `@sha256:…` 주소로 수행합니다. 다른 후보의 파일이나 변경 가능한 `latest` 태그를 섞지 않습니다. [릴리스 절차](releasing.md)를 참고하세요.

Gateway 교체 시 열린 공유 URL이 끝나므로 점검 시간을 잡고 개발자가 새 공유를 시작해야 함을 안내합니다. 저장된 리뷰와 영구 링크는 별도로 유지됩니다. 전환용 백업 전에는 쓰기를 멈춥니다. 격리 복원과 후보 검사가 끝날 때까지 기존 설치를 보관합니다.

## DB 변경 18–21번

| 번호 | 현재 의미 |
| --- | --- |
| 18 | 리뷰 이벤트 보존과 오래된 커서 재동기화. 이미 GitHub 운영 계열에서 사용한 번호 유지 |
| 19 | 재검토 상태·workflow version·처리 이력 |
| 20 | 답글 알림 유형과 수신자·읽지 않음 인덱스 |
| 21 | 재검토 요청·결과 알림과 수신자·원인별 중복 방지 |

과거 로컬 계열은 다른 변경에 18번을 사용하고 20번까지 진행했습니다. 기존 적용 번호나 시각을 지우고 다시 넣지 않습니다. 현재 migration은 번호뿐 아니라 보존 테이블의 존재도 확인해 빠진 구조를 만들며 기존 적용 시각을 유지합니다. 고정된 [GitHub 18번](../packages/storage-postgres/src/fixtures/review-schema-github-18.sql)·[로컬 20번](../packages/storage-postgres/src/fixtures/review-schema-local-20.sql) fixture에서 리뷰 데이터를 가진 업그레이드를 검사합니다. 이벤트 기준점 변경으로 클라이언트가 새 스냅샷을 읽을 수 있지만 댓글은 보존합니다.

새 Gateway를 시작하기 전에 DDL 전용 계정으로 후보 Admin CLI의 `migrate`를 실행합니다. `DATABASE_URL`은 대상 DB의 값으로 비공개 주입되어 있어야 합니다.

```sh
docker run --rm --network <database-network> -e DATABASE_URL <admin-image@sha256:digest> migrate
```

같은 명령을 반복한 뒤에도 기존 번호·적용 시각이 유지되는지 확인합니다.

```sql
SELECT version, applied_at FROM rt_schema_migrations ORDER BY version;
```

Gateway는 `AUTO_MIGRATE=false`로 유지합니다. migration과 호환 Gateway 교체 후 `REVIEW_WORKFLOW_ENABLED=true`로 새 재검토 요청을 켭니다. 다시 `false`로 바꿔도 기존 `NEEDS_REVIEW` 상태나 처리 이력이 지워지지는 않습니다.

## 백업 후 빈 DB에 복원

후보의 PostgreSQL 17.11 검증 환경에는 17.11 도구를 사용합니다. 다른 서버 버전은 PostgreSQL 도구와 서버의 major 버전 호환성을 추가로 확인합니다. 백업·복원 이미지에는 고정된 PostgreSQL 도구가 들어 있습니다.

1. `docker run --rm --entrypoint id <backup-image@sha256:digest>`로 이미지의 실제 `postgres` UID·GID를 확인합니다. 그 사용자가 소유한 `0700` 디렉터리를 준비하고 Gateway의 `node` UID라고 가정하지 않습니다. dump는 `0600`으로 만들어집니다.
2. 원본 DB URL을 `DATABASE_URL`로 주입해 백업합니다.

   ```sh
   docker run --rm --network <database-network> -e DATABASE_URL \
     -v /secure/review-tunnel-backups:/backup \
     <backup-image@sha256:digest> --output-dir /backup
   ```

3. 생성한 dump와 checksum을 암호화된 비공개 저장소에 보관합니다. 비밀번호 hash·세션·리뷰 내용이 들어 있으므로 릴리스 파일로 올리지 않습니다.
4. 비어 있는 별도 DB와 schema 소유 계정을 준비합니다. `RESTORE_DATABASE_URL`과 정확한 `CONFIRM_RESTORE_TARGET=host:port/database`를 주입합니다. IPv6는 `[host]:port/database` 형식입니다.

   ```sh
   docker run --rm --network <restore-network> \
     -e RESTORE_DATABASE_URL -e CONFIRM_RESTORE_TARGET \
     -v /secure/review-tunnel-backups:/backup:ro \
     <restore-image@sha256:digest> --input /backup/<selected-dump>.dump
   ```

복원기는 불변 복사본으로 archive를 검사한 뒤 `--clean --if-exists --no-owner --no-acl`과 단일 transaction으로 실행합니다. 이 옵션이 archive에 없는 객체까지 정리해 주지는 않습니다. 운영 중인 DB나 다른 용도의 객체가 섞인 DB를 훈련 대상으로 쓰지 않습니다. PostgreSQL 기본 DB는 도구가 거부합니다. 세부 옵션은 PostgreSQL의 [dump](https://www.postgresql.org/docs/17/app-pgdump.html)·[restore](https://www.postgresql.org/docs/17/app-pgrestore.html) 문서에서 확인할 수 있습니다.

## DB 접속 권한과 앱 데이터 확인

PostgreSQL 로그인 계정·비밀번호, GRANT와 기존 객체 소유권은 이 도구가 복원하지 않습니다. `rt_accounts` 등에 저장된 **앱 사용자·역할은 DB 데이터로 복원**됩니다. 두 계정 체계를 구분해서 점검합니다.

실제 schema 소유 계정으로 복원하고 runtime 로그인은 비공개로 준비합니다. 전용 `public` schema의 단일 runtime 역할 예시는 다음과 같습니다.

```sql
GRANT USAGE ON SCHEMA public TO review_tunnel_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO review_tunnel_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO review_tunnel_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE review_tunnel_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO review_tunnel_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE review_tunnel_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO review_tunnel_runtime;
```

예시 역할 이름을 실제 값으로 바꿉니다. runtime 역할이 schema 소유자이거나 schema 생성 권한을 가지면 안 됩니다. 복원 후 migration을 다시 실행하고 기존 적용 시각, 댓글·핀 번호와 좌표, 답글, 재검토 이력, 알림·읽음 상태, 앱 사용자 역할, 운영 상태·감사 기록을 대조합니다. 행 개수뿐 아니라 내용을 비교합니다.

공유를 열기 전에 복원된 kill switch부터 확인합니다. 새 후보 배포 ID를 사용하며 과거 canary·admission 기록으로 새 후보를 승인하지 않습니다. 실제 DNS·TLS·프록시 canary 성공을 기록하고 해당 ID를 따로 승인합니다. 전용 계정으로 새 로그인, 관리자 전용 계정의 콘텐츠 접근 거부, 알림 수신자 분리와 새 공유를 확인합니다. 운영 dump를 무관한 테스트 사용자에게 노출하지 않습니다. 복원 시간·백업 시점을 기록하되 작은 가상 데이터 훈련 결과를 운영 RTO·RPO 보장으로 표시하지 않습니다.

## 앱 롤백과 DB 복구

앱 롤백은 현재 DB와 호환성을 검증한 이전 이미지를 다시 실행하는 일입니다. 적용 번호를 지우거나 과거 migrator를 실행해 다운그레이드하지 않습니다. 재검토 이전 GitHub 18번 구현은 새 상태를 모두 이해하지 못하며, workflow flag를 끄는 것만으로 이전 schema가 되지 않습니다. 이전 이미지가 새 데이터를 처리할 수 있는지 먼저 훈련해야 합니다.

DB 복구는 선택한 백업을 대체 DB에 복원하고 검증된 설치를 그 DB로 전환하는 일입니다. 백업 이후의 쓰기는 따로 대조·이관하지 않으면 포함되지 않습니다. 실패한 DB를 바로 덮어쓰지 말고 비공개로 보관해 비교합니다. 복원으로 과거 실행 중이던 공유 URL이 살아나지는 않습니다.

현재 자동 배포의 실패 복구는 이전 컨테이너를 다시 시작하지만 **이미 적용한 DB 변경을 되돌리지는 않습니다.** 후보 검사에서 이전 이미지의 호환성을 확인해야 합니다. [자동 배포](automatic-deployment.md)와 [Linux 백업·복원](linux-deployment.md#postgresql-백업과-복구-훈련) 안내를 함께 따릅니다.
