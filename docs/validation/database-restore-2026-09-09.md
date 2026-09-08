# Candidate database restoration — 2026-09-09

This is a synthetic, isolated restoration drill, not an operation on the deployed database. The planned `v0.1.0-alpha.1` release remains unpublished.

## Current evidence

The first macOS drill passed in 32.5 seconds using PostgreSQL 17.11 and the candidate application based on `f62050bded256666f6733e46c2ea03874151debc`, with the new restoration test still in the working tree. Its four locally built images were inspected for that revision and invoked by immutable local image ID. The PostgreSQL 17.11 source change separately passed the [complete Linux CI](https://github.com/ddussi/lotur/actions/runs/34259954403). That earlier CI did not contain this restoration drill.

The new CI step is awaiting its first Linux result. It must run the restored Gateway image, alongside actual Admin CLI, backup and restore images, before release candidate files can be generated. The macOS run uses the Gateway source on the host to preserve the existing loopback-only HTTP authentication restriction; it does not claim a macOS Gateway container result.

## What the drill checks

The [browser scenario](../../tests/release/restore.spec.mjs) creates developer/reviewer accounts through the existing demo, a region pin, a mention, a reply, two re-review requests and a request for further changes. At the backup point there are five notifications, including read/unread records, and three workflow-history rows. Source processes stop before comparison and backup; only their owned database restarts for the dump.

The [restoration runtime](../../tests/release/restore-runtime.mjs) then checks:

1. A new owned volume is `0700`, the single completed custom-format dump is `0600`, and the image's actual PostgreSQL UID owns it. The initial synthetic dump was 133,286 bytes; its size is not a production capacity estimate.
2. An incorrect restore-target confirmation is refused before it changes the empty destination database.
3. All contents of 24 public tables and the state of both sequences match after restoration. Comparison includes application account roles/password hashes, sessions, audit/operational data, migration timestamps, anchor geometry/pin numbering, replies, workflow history and notification recipients/read times. Private rows are compared in memory and are omitted from reports and assertion output.
4. Source PostgreSQL login roles are absent from the destination. A new runtime role cannot read until grants are applied, can then perform required reads/writes, and cannot create tables. It has no superuser, role/database-creation or RLS-bypass privileges.
5. Running the candidate migrator twice leaves all restored records, timestamps and sequence state unchanged.
6. Old admission rows do not admit a newly identified Gateway. A new local public-path canary, recorded result and explicit approval admit that exact new identity.
7. Fresh developer/reviewer logins can see the saved reviews. An unauthenticated API request returns 401, an admin-only account is denied review content, and each inbox contains only the intended recipients' notifications.
8. A new reply and resolution propagate between the two users. A new share URL retains the restored pin, thread, reply and resolved status.

The initial restore command took 446 ms. This measures one small local synthetic operation, not production RTO/RPO. Server, `pg_dump` and `pg_restore` all reported `17.11 (Debian 17.11-1.pgdg12+2)`. The PostgreSQL image is pinned to `postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.

The first attempt stopped before backup because a local zsh command produced the wrong image tag. Correcting only those newly created local tags allowed the actual drill to run. No test assertion or application behavior was relaxed.

## Reproduction and remaining checks

Use the image build commands in [Contributing](../../CONTRIBUTING.md#exercise-backup-and-restoration), followed by `npm run test:restore`. CI uses the same test with `RESTORE_TEST_IMAGE_TAG=ci`; only its sanitized JSON evidence may be retained as an artifact. The test removes its own source and destination databases, backup volume, network and runner log. Do not publish traces or dumps.

The Linux result, previous Gateway image compatibility, isolated real DNS/TLS/proxy validation, and final refreshed registry candidate remain separate required checks in the [alpha plan](../open-source-alpha-plan.md). This drill does not prove that an older pre-workflow implementation can interpret the current schema or that a database downgrade is safe. Follow the [upgrade guide](../upgrading.en.md) when planning restoration and application rollback.
