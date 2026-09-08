# Upgrading and restoring an alpha installation

[한국어](upgrading.md)

`v0.1.0-alpha.1` is a candidate, not a published release. This procedure describes the implemented tools and required operator checks. The [isolated restoration drill](validation/database-restore-2026-09-09.md) passed on macOS and against real Linux images. The final release still needs its own selected candidate and hosted/rollback results from the [alpha plan](open-source-alpha-plan.md).

## Select and preserve the versions

Record the current source commit, Gateway/Admin CLI/canary image digests, deployment ID and configuration digest. Preserve the current deployment configuration and secrets in private storage. Keep the previous images available. A database dump does not contain DNS/TLS configuration, HMAC keys, Docker settings, or live tunnel routes.

Select the new source/package manifest and complete six-image record from the same successful candidate run. Match their version and full source SHA. Use the recorded `@sha256:…` references for migration, runtime, backup and restore. Do not substitute a mutable `latest` tag or combine files from different candidates. See the [release procedure](releasing.md).

Gateway replacement ends active share URLs. Plan a maintenance window and explain that developers must start new shares; stored reviews and permanent links have a different lifetime. Quiesce writes before the cutover backup. Keep the existing installation available until the isolated restore and candidate checks pass.

## Database migration 18–21

| Number | Current meaning |
| --- | --- |
| 18 | Review event retention and safe cursor resynchronization; preserves the version already used by the deployed GitHub line. |
| 19 | Re-review states, workflow version and processing history. |
| 20 | Reply notification reasons and recipient/unread indexes. |
| 21 | Re-review request/result notifications and recipient/source deduplication. |

An older local development line used 18 for a different change and advanced to 20. Do not delete, renumber or reinsert those historical migration rows. The current migration inspects the retention table as well as the recorded version, creates missing structures, and leaves existing migration timestamps intact. The fixed [GitHub 18](../packages/storage-postgres/src/fixtures/review-schema-github-18.sql) and [local 20](../packages/storage-postgres/src/fixtures/review-schema-local-20.sql) fixtures exercise both upgrade paths with saved reviews. New event baselines can force clients to fetch a fresh snapshot; comments are retained.

Use a DDL role to run the candidate Admin CLI's existing `migrate` command before starting the new Gateway. `DATABASE_URL` below must already be injected privately and point at the intended database:

```sh
docker run --rm --network <database-network> -e DATABASE_URL <admin-image@sha256:digest> migrate
```

Check the applied versions and timestamps before and after repeating that command:

```sql
SELECT version, applied_at FROM rt_schema_migrations ORDER BY version;
```

Keep Gateway automatic migration disabled (`AUTO_MIGRATE=false`). Enable new re-review requests with `REVIEW_WORKFLOW_ENABLED=true` only after migrating and replacing the Gateway with a compatible version. Setting this flag back to `false` stops new requests; it does not erase existing `NEEDS_REVIEW` states or their history.

## Back up, then restore into an empty database

Use PostgreSQL 17.11 tools for the candidate's PostgreSQL 17.11 validation environment. Tool/server major-version compatibility must also be checked for another server version. The release's backup/restore images bundle their own PostgreSQL tools.

1. Create a private backup directory owned by the image's actual `postgres` UID/GID. Inspect it with `docker run --rm --entrypoint id <backup-image@sha256:digest>`; do not assume the Gateway's `node` UID. The directory must be `0700`. Backup files are created as `0600`.
2. Run the backup with the selected source database URL injected as `DATABASE_URL`:

   ```sh
   docker run --rm --network <database-network> -e DATABASE_URL \
     -v /secure/review-tunnel-backups:/backup \
     <backup-image@sha256:digest> --output-dir /backup
   ```

3. Preserve the resulting custom-format dump and a checksum in encrypted private storage. It includes password hashes, sessions and review content; it is never a release artifact.
4. Prepare a new, empty, isolated database and its migration owner. Inject its URL as `RESTORE_DATABASE_URL`, and set `CONFIRM_RESTORE_TARGET` to the exact `host:port/database` printed by the tool (IPv6 uses `[host]:port/database`). Run the restore image with the selected dump mounted read-only:

   ```sh
   docker run --rm --network <restore-network> \
     -e RESTORE_DATABASE_URL -e CONFIRM_RESTORE_TARGET \
     -v /secure/review-tunnel-backups:/backup:ro \
     <restore-image@sha256:digest> --input /backup/<selected-dump>.dump
   ```

The tool validates an immutable copy of the archive, then restores in a single transaction with `--clean --if-exists --no-owner --no-acl`. These flags do not empty a database of unrelated objects. Do not use a live or mixed-purpose database for a drill. Default PostgreSQL databases are refused. PostgreSQL documents the underlying [dump](https://www.postgresql.org/docs/17/app-pgdump.html) and [restore](https://www.postgresql.org/docs/17/app-pgrestore.html) options.

## Reapply database permissions and validate data

PostgreSQL login roles/passwords, grants and original object ownership are **not restored** by these tools. Application users and roles stored in `rt_accounts` and related tables are restored as data. Keep these two kinds of account separate in the recovery checklist.

Restore as the intended schema owner and provision the runtime login privately. Apply your deployment's grants explicitly. For a dedicated `public` schema, the existing single-runtime-role pattern is:

```sql
GRANT USAGE ON SCHEMA public TO review_tunnel_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO review_tunnel_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO review_tunnel_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE review_tunnel_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO review_tunnel_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE review_tunnel_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO review_tunnel_runtime;
```

Replace these example role names with the actual owner/runtime roles. The runtime role must not own the schema or have schema-creation privileges. Run migration again after restoration and verify existing migration timestamps, reviews, anchor coordinates/pin numbers, replies, workflow history, notifications/read state, application account roles, and operational/audit records. Check content as well as row counts.

Inspect the restored kill switch before starting shares. Use a new candidate deployment identity: old canary/admission rows do not approve it. Complete the new DNS/TLS/proxy canary, record its result and approve that exact identity separately. Test fresh login, admin-only content denial, recipient separation and a new share with dedicated accounts. Do not expose a restored production dump to unrelated test users. Record restore duration and the backup point; a small synthetic drill does not establish production RTO/RPO.

## Roll back the application or recover the database

Application rollback means running a previously validated image against a compatible current schema. Do not drop migration rows or run an older migrator to simulate a downgrade. The pre-workflow GitHub-18 implementation does not understand all current states; changing the workflow flag is not a schema downgrade. A rollback target must be proven against the new data before relying on it.

Database recovery means restoring a selected backup into a replacement database and switching the validated deployment to it. Data written after that backup point is absent unless separately reconciled. Retain the failed database privately for comparison; do not overwrite it as the first recovery action. Restoring data does not recreate live share URLs.

The existing automatic deployment restores the previous container after a failed rollout; it does **not** reverse already-applied DB changes. Candidate testing must establish that previous image's compatibility. See the [automatic deployment runbook](automatic-deployment.md) and [Linux operations guide](linux-deployment.md#postgresql-백업과-복구-훈련).
