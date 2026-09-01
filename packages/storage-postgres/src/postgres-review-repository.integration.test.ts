import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

import {
  ReviewError,
  createReviewService,
  type ReviewActor,
} from "../../review/src/index.ts";
import { PostgresAuthRepository } from "./postgres-auth-repository.ts";
import { PostgresReviewRepository } from "./postgres-review-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const now = new Date("2026-08-31T00:00:00.000Z");

const developer: ReviewActor = {
  accountId: "review-developer",
  username: "review-developer",
  authorizationVersion: 1,
  displayName: "Developer",
  capabilities: {
    canRead: true,
    canComment: true,
    canManageProject: true,
  },
};

const reviewer: ReviewActor = {
  accountId: "review-reviewer",
  username: "review-reviewer",
  authorizationVersion: 1,
  displayName: "Reviewer",
  capabilities: {
    canRead: true,
    canComment: true,
    canManageProject: false,
  },
};

const otherDeveloper: ReviewActor = {
  ...developer,
  accountId: "review-other-developer",
  username: "review-other-developer",
  displayName: "Other Developer",
};

test("PostgreSQL event cursors never overtake a pending commit in the same review feed", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
  timeout: 20_000,
}, async () => {
  await withReviewRaceDatabase(async (pool, service) => {
    const inserted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const slowPool = observeQueries(pool, async (sql) => {
      if (sql.trimStart().startsWith("INSERT INTO rt_review_events")) {
        inserted.resolve();
        await release.promise;
      }
    });
    const slow = createReviewService({ repository: new PostgresReviewRepository(slowPool), now: () => now });
    const base = { actor: developer, tunnelId: "race", sessionId: "race-session", routePath: "/" };
    const pending = slow.createPageComment({ ...base, body: "first pending commit" });
    let later: Promise<unknown> | undefined;
    try {
      await inserted.promise;
      // A dedicated connection identifies the second writer independently of its SQL implementation.
      const connection = await pool.connect();
      const pid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const connectedPool = { connect: async () => ({ query: connection.query.bind(connection), release() {} }), query: pool.query.bind(pool) } as unknown as Pool;
      const fast = createReviewService({ repository: new PostgresReviewRepository(connectedPool), now: () => now });
      let completed = false;
      later = fast.createPageComment({ ...base, body: "second commit" }).finally(() => { completed = true; connection.release(); });
      const deadline = Date.now() + 5_000;
      while (!completed) {
        const activity = await pool.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") break;
        assert.ok(Date.now() < deadline, "second writer must complete or wait on the first transaction");
        await delay(5);
      }
      assert.deepEqual(await service.listEvents({ ...base, afterId: "0" }), [], "uncommitted earlier events cannot be skipped");
      // Serialization belongs to a feed, not the entire deployment.
      await service.createPageComment({ ...base, routePath: "/independent", body: "independent feed" });
      release.resolve();
      await Promise.all([pending, later]);
      const delivered = await service.listEvents({ ...base, afterId: "0" });
      assert.equal(delivered.length, 2);
      assert.equal(delivered[0]?.threadId, (await pending).id);
      assert.deepEqual(await service.listEvents({ ...base, afterId: delivered[0]!.id }), [delivered[1]]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, ...(later === undefined ? [] : [later])]);
    }
  });
});

test("PostgreSQL page data and initial event cursor share one read snapshot", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
  timeout: 20_000,
}, async () => {
  await withReviewRaceDatabase(async (pool, service) => {
    const base = { actor: developer, tunnelId: "race", sessionId: "race-session", routePath: "/" };
    const first = await service.createPageComment({ ...base, body: "before snapshot" });
    const cursorRead = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observed = observeQueries(pool, async (sql) => {
      if (sql.includes("AS event_cursor")) {
        cursorRead.resolve();
        await release.promise;
      }
    });
    const reader = createReviewService({ repository: new PostgresReviewRepository(observed), now: () => now });
    const reading = reader.listPageCommentPage(base);
    try {
      await cursorRead.promise;
      await service.createPageComment({ ...base, body: "after snapshot" });
      release.resolve();
      const page = await reading;
      assert.deepEqual(page.comments.map((comment) => comment.id), [first.id]);
      assert.equal(page.openCount, 1);
      assert.equal((await service.listEvents({ ...base, afterId: page.eventCursor })).length, 1);
    } finally {
      release.resolve();
      await Promise.allSettled([reading]);
    }
  });
});

function observeQueries(pool: Pool, after: (sql: string) => Promise<void>): Pool {
  return {
    async query(sql: string, values?: unknown[]) {
      const result = await pool.query(sql, values);
      await after(sql);
      return result;
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          await after(sql);
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
}

test("PostgreSQL upgrade resets legacy cursors whose eviction history was not recorded", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  await withReviewRaceDatabase(async (pool, service) => {
    const base = { actor: developer, tunnelId: "race", sessionId: "race-session", routePath: "/" };
    const comment = await service.createPageComment({ ...base, body: "legacy persistent comment" });
    await pool.query("DELETE FROM rt_review_events");
    await pool.query("DROP TABLE rt_review_event_retention");
    await pool.query("DELETE FROM rt_schema_migrations WHERE version = 18");
    const repository = new PostgresReviewRepository(pool);
    await repository.migrate();
    await assert.rejects(service.listEvents({ ...base, afterId: "0" }), (error: unknown) =>
      error instanceof ReviewError && error.code === "CURSOR_EXPIRED");
    const snapshot = await service.listPageCommentPage(base);
    assert.equal(snapshot.comments[0]?.id, comment.id);
    assert.ok(BigInt(snapshot.eventCursor) > 0n);
    await repository.migrate();
    await service.createPageComment({ ...base, body: "after upgrade" });
    assert.equal((await service.listEvents({ ...base, afterId: snapshot.eventCursor })).length, 1);
  });
});

test("PostgreSQL retained event gaps explicitly require resynchronization and an empty feed gets a usable cursor", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
  timeout: 20_000,
}, async () => {
  await withReviewRaceDatabase(async (pool, original) => {
    const base = { actor: developer, tunnelId: "race", sessionId: "race-session", routePath: "/" };
    const initial = await original.listPageCommentPage(base);
    const retained = createReviewService({ repository: new PostgresReviewRepository(pool, { maxEvents: 2 }), now: () => now });
    for (const body of ["one", "two", "three"]) await retained.createPageComment({ ...base, body });
    await assert.rejects(retained.listEvents({ ...base, afterId: initial.eventCursor }), (error: unknown) =>
      error instanceof ReviewError && error.code === "CURSOR_EXPIRED");
    assert.equal((await retained.listEvents(base)).length, 2, "legacy non-resuming queries can read retained history");
    assert.equal((await retained.listEvents({ ...base, afterId: "1" })).length, 2, "deleting an already delivered event is harmless");
    await pool.query("UPDATE rt_review_events SET occurred_at = $1", [new Date(now.getTime() - 2_000)]);
    const expiring = createReviewService({ repository: new PostgresReviewRepository(pool, { maxEventAgeMs: 1_000 }), now: () => now });
    await expiring.createPageComment({ ...base, routePath: "/other", body: "expire older events" });
    await assert.rejects(expiring.listEvents({ ...base, afterId: "1" }), (error: unknown) =>
      error instanceof ReviewError && error.code === "CURSOR_EXPIRED");
    const restarted = createReviewService({ repository: new PostgresReviewRepository(pool), now: () => now });
    const refreshed = await restarted.listPageCommentPage(base);
    assert.equal(refreshed.eventCursor, "3", "a fully trimmed feed keeps its last removed cursor");
    assert.deepEqual(await restarted.listEvents({ ...base, afterId: refreshed.eventCursor }), []);
    const newest = await restarted.createPageComment({ ...base, body: "after resynchronization" });
    assert.equal((await restarted.listEvents({ ...base, afterId: refreshed.eventCursor }))[0]?.threadId, newest.id);
  });
});

async function withReviewRaceDatabase(
  work: (pool: Pool, service: ReturnType<typeof createReviewService>) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_review_race_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
  try {
    await new PostgresAuthRepository(pool).migrate();
    const repository = new PostgresReviewRepository(pool);
    await repository.migrate();
    await insertAccount(pool, developer, ["DEVELOPER"]);
    const service = createReviewService({ repository, now: () => now });
    await service.bindTunnel({ actor: developer, tunnelOwnerAccountId: developer.accountId, tunnelId: "race", sessionId: "race-session", projectSlug: "race-project", revisionKey: "race-revision" });
    await work(pool, service);
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
}

test("PostgreSQL persists and isolates review projects, revisions, bindings, and page comments", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_review_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 12,
    options: `-c search_path=${schema}`,
  });
  try {
    await new PostgresAuthRepository(pool).migrate();
    const repository = new PostgresReviewRepository(pool);
    await repository.migrate();
    await insertAccount(pool, developer, ["DEVELOPER"]);
    await insertAccount(pool, otherDeveloper, ["DEVELOPER"]);
    await insertAccount(pool, reviewer, ["REVIEWER"]);

    let sequence = 0;
    const service = createReviewService({
      repository,
      generateId: () => `postgres-review-${++sequence}`,
      now: () => now,
    });
    const first = await service.bindTunnel({
      actor: developer,
      tunnelOwnerAccountId: developer.accountId,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      projectSlug: "storefront",
      revisionKey: "commit-a",
    });
    await Promise.all([
      service.bindTunnel({
        actor: developer,
        tunnelOwnerAccountId: developer.accountId,
        tunnelId: "tunnel-a2",
        sessionId: "session-a2",
        projectSlug: "storefront",
        revisionKey: "commit-a",
      }),
      service.bindTunnel({
        actor: developer,
        tunnelOwnerAccountId: developer.accountId,
        tunnelId: "tunnel-a3",
        sessionId: "session-a3",
        projectSlug: "storefront",
        revisionKey: "commit-a",
      }),
    ]);
    const otherRevision = await service.bindTunnel({
      actor: developer,
      tunnelOwnerAccountId: developer.accountId,
      tunnelId: "tunnel-b",
      sessionId: "session-b",
      projectSlug: "storefront",
      revisionKey: "commit-b",
    });
    assert.equal(first.project.id, otherRevision.project.id);
    assert.notEqual(first.revision.id, otherRevision.revision.id);
    const otherProject = await service.bindTunnel({
      actor: otherDeveloper,
      tunnelOwnerAccountId: otherDeveloper.accountId,
      tunnelId: "tunnel-other-owner",
      sessionId: "session-other-owner",
      projectSlug: "storefront",
      revisionKey: "commit-a",
    });
    assert.notEqual(first.project.id, otherProject.project.id);
    assert.notEqual(first.revision.id, otherProject.revision.id);

    const created = await service.createPageComment({
      actor: reviewer,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      routePath: "/products",
      body: "Check the primary action",
    });
    const region = await service.createRegionComment({
      actor: reviewer,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      routePath: "/products",
      body: "Pin the secondary action",
      anchor: {
        type: "REGION_V1",
        selection: "RECT",
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        document: { width: 1440, height: 3200 },
        viewport: { width: 1280, height: 720 },
      },
    });
    const reply = await service.createReply({
      actor: reviewer,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      commentId: created.id,
      routePath: "/products",
      body: "The label also needs clarification",
    });
    const restartedService = createReviewService({
      repository: new PostgresReviewRepository(pool),
      now: () => now,
    });
    const persistedComments = (await restartedService.listPageCommentPage({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
    })).comments;
    assert.equal(persistedComments[0]?.id, created.id);
    assert.deepEqual(persistedComments[0]?.replies, [reply]);
    assert.deepEqual(
      persistedComments.find((comment) => comment.id === region.id)?.anchor,
      region.anchor,
    );
    const persistedEvents = await restartedService.listEvents({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
    });
    assert.deepEqual(persistedEvents.map((event) => event.type), [
      "COMMENT_CREATED",
      "COMMENT_CREATED",
      "REPLY_CREATED",
    ]);
    assert.deepEqual((await restartedService.listEvents({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
      afterId: persistedEvents[1]!.id,
    })).map((event) => event.id), [persistedEvents[2]!.id]);

    const editRace = await Promise.allSettled([
      restartedService.updateComment({
        actor: reviewer,
        tunnelId: "tunnel-a2",
        sessionId: "session-a2",
        commentId: region.id,
        routePath: "/products",
        expectedVersion: 1,
        body: "@review-developer First concurrent edit",
      }),
      restartedService.updateComment({
        actor: reviewer,
        tunnelId: "tunnel-a3",
        sessionId: "session-a3",
        commentId: region.id,
        routePath: "/products",
        expectedVersion: 1,
        body: "@review-developer Second concurrent edit",
      }),
    ]);
    assert.equal(editRace.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedEdit = editRace.find((result) => result.status === "rejected");
    assert.ok(
      rejectedEdit?.status === "rejected" &&
      rejectedEdit.reason instanceof ReviewError &&
      rejectedEdit.reason.code === "VERSION_CONFLICT",
    );
    const mentionNotifications = await restartedService.listNotifications({
      actor: developer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
    });
    assert.equal(mentionNotifications.length, 1);
    assert.equal(mentionNotifications[0]?.actor.accountId, reviewer.accountId);
    assert.deepEqual(await restartedService.listNotifications({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
    }), []);
    assert.deepEqual((await restartedService.listEvents({
      actor: developer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
      afterId: persistedEvents.at(-1)!.id,
    })).map((event) => event.type), ["COMMENT_UPDATED", "NOTIFICATION_CREATED"]);
    const readNotification = await restartedService.setNotificationRead({
      actor: developer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      notificationId: mentionNotifications[0]!.id,
      routePath: "/products",
      read: true,
    });
    assert.ok(readNotification.readAt instanceof Date);
    assert.deepEqual((await restartedService.listEvents({
      actor: developer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
      afterId: persistedEvents.at(-1)!.id,
    })).map((event) => event.type), [
      "COMMENT_UPDATED",
      "NOTIFICATION_CREATED",
      "NOTIFICATION_READ_CHANGED",
    ]);
    const deletedRegion = await restartedService.deleteComment({
      actor: developer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      commentId: region.id,
      routePath: "/products",
      expectedVersion: 2,
    });
    assert.equal(deletedRegion.body, null);
    assert.equal(deletedRegion.version, 3);
    assert.equal((await restartedService.listPageCommentPage({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
    })).openCount, 1);

    const editedReply = await restartedService.updateReply({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      commentId: created.id,
      replyId: reply.id,
      routePath: "/products",
      expectedVersion: 1,
      body: "Edited persisted reply",
    });
    assert.equal(editedReply.version, 2);
    const deletedReply = await restartedService.deleteReply({
      actor: developer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      commentId: created.id,
      replyId: reply.id,
      routePath: "/products",
      expectedVersion: 2,
    });
    assert.equal(deletedReply.body, null);
    assert.equal(deletedReply.version, 3);
    assert.deepEqual(
      (await restartedService.listPageCommentPage({
        actor: reviewer,
        tunnelId: "tunnel-b",
        sessionId: "session-b",
        routePath: "/products",
      })).comments,
      [],
    );

    await assert.rejects(
      restartedService.createReply({
        actor: reviewer,
        tunnelId: "tunnel-other-owner",
        sessionId: "session-other-owner",
        commentId: created.id,
        routePath: "/products",
        body: "Another project cannot see this thread",
      }),
      (error: unknown) => error instanceof ReviewError && error.code === "NOT_FOUND",
    );

    const statusRace = await Promise.allSettled([
      service.changePageCommentStatus({
        actor: developer,
        tunnelId: "tunnel-a",
        sessionId: "session-a",
        commentId: created.id,
        routePath: "/products",
        expectedStatus: "OPEN",
        status: "RESOLVED",
      }),
      service.changePageCommentStatus({
        actor: developer,
        tunnelId: "tunnel-a2",
        sessionId: "session-a2",
        commentId: created.id,
        routePath: "/products",
        expectedStatus: "OPEN",
        status: "RESOLVED",
      }),
    ]);
    assert.equal(
      statusRace.filter((result) => result.status === "fulfilled").length,
      1,
      statusRace.map((result) => result.status === "fulfilled"
        ? "fulfilled"
        : result.reason instanceof Error
        ? `${result.reason.name}: ${result.reason.message}`
        : String(result.reason)).join(" | "),
    );
    const rejectedTransition = statusRace.find((result) => result.status === "rejected");
    assert.ok(rejectedTransition?.status === "rejected");
    assert.ok(
      rejectedTransition.reason instanceof ReviewError &&
      rejectedTransition.reason.code === "STATE_CONFLICT",
    );
    const resolved = (await restartedService.listPageCommentPage({
      actor: developer,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      routePath: "/products",
    })).comments[0];
    assert.equal(resolved?.status, "RESOLVED");
    assert.equal(resolved?.resolvedBy?.accountId, developer.accountId);
    assert.ok(resolved?.resolvedAt instanceof Date);
    assert.deepEqual((await restartedService.listEvents({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
      afterId: persistedEvents.at(-1)!.id,
    })).map((event) => event.type), [
      "COMMENT_UPDATED",
      "COMMENT_DELETED",
      "REPLY_UPDATED",
      "REPLY_DELETED",
      "THREAD_STATUS_CHANGED",
    ]);
    const tombstones = (await restartedService.listPageCommentPage({
      actor: reviewer,
      tunnelId: "tunnel-a2",
      sessionId: "session-a2",
      routePath: "/products",
    })).comments;
    assert.equal(tombstones.find((comment) => comment.id === region.id)?.body, null);
    assert.equal(tombstones.find((comment) => comment.id === created.id)?.replies[0]?.body, null);

    const countRetentionService = createReviewService({
      repository: new PostgresReviewRepository(pool, {
        maxEvents: 2,
        maxEventAgeMs: 7 * 24 * 60 * 60 * 1_000,
      }),
      now: () => now,
    });
    for (const body of ["first retained event", "second retained event", "third retained event"]) {
      await countRetentionService.createPageComment({
        actor: reviewer,
        tunnelId: "tunnel-a",
        sessionId: "session-a",
        routePath: "/retention-count",
        body,
      });
    }
    assert.deepEqual(
      (await countRetentionService.listEvents({
        actor: reviewer,
        tunnelId: "tunnel-a",
        sessionId: "session-a",
        routePath: "/retention-count",
      })).map((event) => event.type),
      ["COMMENT_CREATED", "COMMENT_CREATED"],
    );

    await pool.query(
      "UPDATE rt_review_events SET occurred_at = $1",
      [new Date(now.getTime() - 24 * 60 * 60 * 1_000)],
    );
    const ageRetentionService = createReviewService({
      repository: new PostgresReviewRepository(pool, {
        maxEvents: 100,
        maxEventAgeMs: 1_000,
      }),
      now: () => now,
    });
    await ageRetentionService.createPageComment({
      actor: reviewer,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      routePath: "/retention-age",
      body: "new event keeps only the live retention window",
    });
    const retainedEventCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rt_review_events",
    );
    assert.equal(retainedEventCount.rows[0]?.count, "1");

    await repository.migrate();
    await pool.query(
      `INSERT INTO rt_review_threads
       (id, revision_id, route_path, anchor_type, anchor, status, body,
        author_account_id, created_at, updated_at)
       VALUES ($1, $2, '/legacy', 'PAGE', NULL, 'OPEN', 'Legacy page comment', $3, $4, $4)`,
      ["legacy-phase-one-thread", first.revision.id, reviewer.accountId, now],
    );
    const legacy = (await restartedService.listPageCommentPage({
      actor: reviewer,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      routePath: "/legacy",
    })).comments[0];
    assert.equal(legacy?.status, "OPEN");
    assert.deepEqual(legacy?.replies, []);
    assert.equal(legacy?.resolvedBy, undefined);
    assert.deepEqual(
      (await restartedService.listPageCommentPage({
        actor: reviewer,
        tunnelId: "tunnel-other-owner",
        sessionId: "session-other-owner",
        routePath: "/products",
      })).comments,
      [],
    );
    assert.deepEqual(
      (await restartedService.listPageCommentPage({
        actor: reviewer,
        tunnelId: "tunnel-a",
        sessionId: "session-a",
        routePath: "/cart",
      })).comments,
      [],
    );

    const counts = await pool.query<{
      projects: string;
      revisions: string;
      bindings: string;
      threads: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM rt_review_projects) AS projects,
         (SELECT count(*)::text FROM rt_review_revisions) AS revisions,
         (SELECT count(*)::text FROM rt_review_tunnel_bindings) AS bindings,
         (SELECT count(*)::text FROM rt_review_threads) AS threads`,
    );
    assert.deepEqual(counts.rows[0], {
      projects: "2",
      revisions: "3",
      bindings: "5",
      threads: "7",
    });

    await assert.rejects(
      service.bindTunnel({
        actor: developer,
        tunnelOwnerAccountId: developer.accountId,
        tunnelId: "tunnel-a",
        sessionId: "different-session",
        projectSlug: "storefront",
        revisionKey: "commit-a",
      }),
      (error: unknown) => error instanceof ReviewError && error.code === "CONFLICT",
    );
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL review mutations reject authorization revoked before transaction lock", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_review_auth_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  try {
    await new PostgresAuthRepository(pool).migrate();
    const repository = new PostgresReviewRepository(pool);
    await repository.migrate();
    await insertAccount(pool, developer, ["DEVELOPER"]);
    await insertAccount(pool, reviewer, ["REVIEWER"]);
    const service = createReviewService({ repository });
    await service.bindTunnel({
      actor: developer,
      tunnelOwnerAccountId: developer.accountId,
      tunnelId: "tunnel-stale",
      sessionId: "session-stale",
      projectSlug: "storefront",
      revisionKey: "commit-a",
    });

    const thread = await service.createPageComment({
      actor: reviewer,
      tunnelId: "tunnel-stale",
      sessionId: "session-stale",
      routePath: "/",
      body: "Created before authorization changes",
    });
    await pool.query(
      "UPDATE rt_accounts SET auth_version = auth_version + 1 WHERE id = $1",
      [reviewer.accountId],
    );
    await assert.rejects(
      service.createReply({
        actor: reviewer,
        tunnelId: "tunnel-stale",
        sessionId: "session-stale",
        commentId: thread.id,
        routePath: "/",
        body: "stale authorization must not append",
      }),
      (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      service.listEvents({
        actor: reviewer,
        tunnelId: "tunnel-stale",
        sessionId: "session-stale",
        routePath: "/",
      }),
      (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
    );
    await pool.query(
      "UPDATE rt_accounts SET auth_version = auth_version + 1 WHERE id = $1",
      [developer.accountId],
    );
    await assert.rejects(
      service.changePageCommentStatus({
        actor: developer,
        tunnelId: "tunnel-stale",
        sessionId: "session-stale",
        commentId: thread.id,
        routePath: "/",
        expectedStatus: "OPEN",
        status: "RESOLVED",
      }),
      (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
    );
    const count = await pool.query<{ replies: string; open_threads: string }>(
      `SELECT
         (SELECT count(*)::text FROM rt_review_replies) AS replies,
         (SELECT count(*)::text FROM rt_review_threads WHERE status = 'OPEN') AS open_threads`,
    );
    assert.deepEqual(count.rows[0], { replies: "0", open_threads: "1" });
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL review pages keep newest comments, replies, pins, and expired-binding recovery", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_review_pages_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  try {
    await new PostgresAuthRepository(pool).migrate();
    const repository = new PostgresReviewRepository(pool);
    await repository.migrate();
    await insertAccount(pool, developer, ["DEVELOPER"]);
    await insertAccount(pool, reviewer, ["REVIEWER"]);
    let currentTime = now;
    let sequence = 0;
    const service = createReviewService({
      repository,
      now: () => currentTime,
      generateId: () => `page-review-${String(++sequence).padStart(4, "0")}`,
    });
    await service.bindTunnel({
      actor: developer,
      tunnelOwnerAccountId: developer.accountId,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      projectSlug: "page-project",
      revisionKey: "commit-page",
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    const comments = [];
    for (let index = 0; index < 101; index += 1) {
      currentTime = new Date(currentTime.getTime() + 1);
      comments.push(await service.createRegionComment({
        actor: reviewer,
        tunnelId: "page-tunnel",
        sessionId: "page-session-one",
        routePath: "/pages",
        body: `region ${index + 1}`,
        anchor: {
          type: "REGION_V1",
          selection: "POINT",
          x: 0.5,
          y: 0.5,
          width: 0,
          height: 0,
          document: { width: 1280, height: 2400 },
          viewport: { width: 1280, height: 720 },
        },
      }));
    }
    const replies = [];
    for (let index = 0; index < 101; index += 1) {
      currentTime = new Date(currentTime.getTime() + 1);
      replies.push(await service.createReply({
        actor: reviewer,
        tunnelId: "page-tunnel",
        sessionId: "page-session-one",
        commentId: comments.at(-1)!.id,
        routePath: "/pages",
        body: `reply ${index + 1}`,
      }));
    }

    const firstPage = await service.listPageCommentPage({
      actor: reviewer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      routePath: "/pages",
    });
    assert.equal(firstPage.comments.length, 100);
    assert.equal(firstPage.comments[0]?.pinNumber, 2);
    assert.equal(firstPage.comments.at(-1)?.pinNumber, 101);
    assert.equal(firstPage.openCount, 101);
    assert.equal(firstPage.pageInfo.hasMore, true);
    assert.equal(typeof firstPage.eventCursor, "string");
    assert.deepEqual(await service.listEvents({
      actor: reviewer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      routePath: "/pages",
      afterId: firstPage.eventCursor,
    }), []);
    const latestThread = firstPage.comments.at(-1)!;
    assert.equal(latestThread.replies.length, 100);
    assert.equal(latestThread.replies[0]?.id, replies[1]?.id);
    assert.equal(latestThread.replies.at(-1)?.id, replies.at(-1)?.id);
    assert.equal(latestThread.replyPageInfo.hasMore, true);

    const updatedLatestThread = await service.updateComment({
      actor: reviewer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      commentId: latestThread.id,
      routePath: "/pages",
      expectedVersion: latestThread.version,
      body: "updated newest thread",
    });
    assert.equal(updatedLatestThread.replies.length, 100);
    assert.equal(updatedLatestThread.replies[0]?.id, replies[1]?.id);
    assert.equal(updatedLatestThread.replies.at(-1)?.id, replies.at(-1)?.id);

    const olderComments = await service.listPageCommentPage({
      actor: reviewer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      routePath: "/pages",
      before: firstPage.pageInfo.nextCursor!,
    });
    assert.deepEqual(olderComments.comments.map((comment) => comment.pinNumber), [1]);
    const olderReplies = await service.listReplyPage({
      actor: reviewer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      commentId: latestThread.id,
      routePath: "/pages",
      before: latestThread.replyPageInfo.nextCursor!,
    });
    assert.deepEqual(olderReplies.replies.map((reply) => reply.id), [replies[0]!.id]);

    await service.changePageCommentStatus({
      actor: developer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      commentId: comments[0]!.id,
      routePath: "/pages",
      expectedStatus: "OPEN",
      status: "RESOLVED",
    });
    assert.equal((await service.listPageCommentPage({
      actor: reviewer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-one",
      routePath: "/pages",
    })).openCount, 100);

    currentTime = new Date(now.getTime() + 10 * 60_000 + 1);
    await assert.rejects(
      service.listPageCommentPage({
        actor: reviewer,
        tunnelId: "page-tunnel",
        sessionId: "page-session-one",
        routePath: "/pages",
      }),
      (error: unknown) => error instanceof ReviewError && error.code === "NOT_FOUND",
    );
    await service.bindTunnel({
      actor: developer,
      tunnelOwnerAccountId: developer.accountId,
      tunnelId: "page-tunnel",
      sessionId: "page-session-two",
      projectSlug: "page-project",
      revisionKey: "commit-page",
      expiresAt: new Date(currentTime.getTime() + 60_000),
    });
    assert.equal((await service.listPageCommentPage({
      actor: reviewer,
      tunnelId: "page-tunnel",
      sessionId: "page-session-two",
      routePath: "/pages",
    })).comments.at(-1)?.pinNumber, 101);
    assert.equal((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rt_review_tunnel_bindings",
    )).rows[0]?.count, "1");
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

async function insertAccount(
  pool: Pool,
  actor: ReviewActor,
  roles: readonly string[],
): Promise<void> {
  await pool.query(
    `INSERT INTO rt_accounts
     (id, username, display_name, roles, password_hash, enabled,
      must_change_password, auth_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, true, false, $6, $7, $7)`,
    [
      actor.accountId,
      actor.accountId,
      actor.displayName,
      roles,
      "not-used-by-review-tests",
      actor.authorizationVersion,
      now,
    ],
  );
}
