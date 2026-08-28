import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

import {
  Argon2idPasswordHasher,
  AuthError,
  AuthService,
  AuditEventCapacityError,
  type Account,
  type PasswordHasher,
} from "../../auth/src/index.ts";
import { OperationalStateError, parseDeploymentIdentity } from "../../operations/src/index.ts";
import { PostgresAuthRepository } from "./postgres-auth-repository.ts";
import { PostgresOperationalStateRepository } from "./postgres-operational-state-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

class FastTestHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

const DISCARD_AUTHENTICATION_EVENTS = { write() {}, reportFailure() {} };

test("PostgreSQL persists Argon2id accounts and opaque sessions", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_test_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  try {
    const repository = new PostgresAuthRepository(pool);
    await repository.migrate();
    const hasher = new Argon2idPasswordHasher();
    const service = new AuthService({
      repository,
      passwordHasher: hasher,
      sessionHmacKey: Buffer.alloc(32, 4),
      dummyPasswordHash: await hasher.hash("constant-dummy-password-not-used"),
      authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
    });
    const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
    const stored = await repository.findAccountByUsername("admin");
    assert.match(stored?.passwordHash ?? "", /^\$argon2id\$/);
    assert.notEqual(stored?.passwordHash, bootstrap.temporaryPassword);

    const login = await service.authenticate({
      username: "admin",
      password: bootstrap.temporaryPassword,
      remoteAddress: "127.0.0.1",
    });
    const restartedRepository = new PostgresAuthRepository(pool);
    const restartedService = new AuthService({
      repository: restartedRepository,
      passwordHasher: hasher,
      sessionHmacKey: Buffer.alloc(32, 4),
      dummyPasswordHash: await hasher.hash("constant-dummy-password-not-used"),
      authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
    });
    assert.equal((await restartedService.resolveSession(login.sessionToken))?.username, "admin");
    await service.changeOwnPassword(login.principal, {
      currentPassword: bootstrap.temporaryPassword,
      newPassword: "administrator-operational-password-2026",
    });
    const operationalLogin = await service.authenticate({
      username: "admin",
      password: "administrator-operational-password-2026",
      remoteAddress: "127.0.0.1",
    });
    const operationalActor = {
      accountId: operationalLogin.principal.accountId,
      accountAuthVersion: operationalLogin.principal.authVersion,
    };

    const identity = parseDeploymentIdentity("release-42", `sha256:${"c".repeat(64)}`);
    const operational = new PostgresOperationalStateRepository(pool);
    assert.equal((await operational.getOperationalState(identity)).canaryStatus, "UNKNOWN");
    await assert.rejects(
      operational.approveAdmission(identity, operationalActor, new Date()),
      (error: unknown) =>
        error instanceof OperationalStateError && error.code === "CANARY_REQUIRED",
    );
    const canary = await operational.recordCanaryResult(
      identity,
      "PASSED",
      operationalActor,
      new Date(),
    );
    assert.equal(canary.admissionApprovedAt, undefined);
    const approved = await operational.approveAdmission(
      identity,
      operationalActor,
      new Date(),
    );
    assert.ok(approved.admissionApprovedAt instanceof Date);
    const restartedOperational = new PostgresOperationalStateRepository(pool);
    assert.ok((await restartedOperational.getOperationalState(identity)).admissionApprovedAt);
    const failed = await operational.recordCanaryResult(
      identity,
      "FAILED",
      operationalActor,
      new Date(),
    );
    assert.equal(failed.admissionApprovedAt, undefined);
    await operational.recordCanaryResult(
      identity,
      "PASSED",
      operationalActor,
      new Date(),
    );
    await operational.approveAdmission(identity, operationalActor, new Date());
    const killed = await operational.setKillSwitch(
      identity,
      true,
      operationalActor,
      new Date(),
    );
    assert.equal(killed.killSwitchEnabled, true);
    assert.equal(killed.canaryStatus, "UNKNOWN");
    assert.equal(killed.admissionApprovedAt, undefined);
    await service.revokeSessions(
      operationalLogin.principal,
      operationalLogin.principal.accountId,
    );
    await assert.rejects(
      operational.setKillSwitch(identity, false, operationalActor, new Date()),
      (error: unknown) =>
        error instanceof OperationalStateError && error.code === "ACTOR_NOT_AUTHORIZED",
    );
    assert.equal((await operational.getOperationalState(identity)).killSwitchEnabled, true);
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL auth commands preserve authorization invariants under concurrency", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_auth_atomic_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    options: `-c search_path=${schema}`,
  });
  try {
    const repository = new PostgresAuthRepository(pool);
    await repository.migrate();
    const now = new Date("2026-08-24T00:00:00.000Z");
    await pool.query(
      `INSERT INTO rt_audit_events(id, action, occurred_at, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      ["duplicate-audit", "LEGACY_TEST_EVENT", now, JSON.stringify({ source: "test" })],
    );
    await pool.query(
      "UPDATE rt_audit_event_capacity SET event_count = 1 WHERE singleton = true",
    );
    const rolledBackAccount: Account = {
      id: "rolled-back-account",
      username: "rolled-back",
      displayName: "Rolled Back",
      roles: ["ADMIN"],
      passwordHash: "hashed:temporary-password",
      enabled: true,
      mustChangePassword: true,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await assert.rejects(repository.createFirstAccount(rolledBackAccount, {
      id: "duplicate-audit",
      action: "ACCOUNT_BOOTSTRAPPED",
      targetAccountId: rolledBackAccount.id,
      occurredAt: now,
      metadata: {},
    }));
    assert.equal(await repository.countAccounts(), 0);

    let sequence = 0;
    const service = new AuthService({
      repository,
      passwordHasher: new FastTestHasher(),
      sessionHmacKey: Buffer.alloc(32, 9),
      dummyPasswordHash: "hashed:not-the-password",
      authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
      now: () => now,
      createId: () => `atomic-id-${++sequence}`,
      createSecret: () => `atomic-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
      loginIntentLimits: { global: 3, perHost: 2 },
    });
    const bootstrap = await service.bootstrapAdministrator({ username: "admin-one", displayName: "Admin One" });
    const temporaryAdmin = await service.authenticate({
      username: "admin-one",
      password: bootstrap.temporaryPassword,
      remoteAddress: "192.0.2.1",
    });
    await service.changeOwnPassword(temporaryAdmin.principal, {
      currentPassword: bootstrap.temporaryPassword,
      newPassword: "administrator-password-2026",
    });
    let administrator = await service.authenticate({
      username: "admin-one",
      password: "administrator-password-2026",
      remoteAddress: "192.0.2.1",
    });
    await service.setAccountRoles(
      administrator.principal,
      administrator.principal.accountId,
      ["ADMIN", "DEVELOPER"],
    );
    administrator = await service.authenticate({
      username: "admin-one",
      password: "administrator-password-2026",
      remoteAddress: "192.0.2.1",
    });
    const carrierCredential = await service.issueCarrierCredential(administrator.principal, {
      purpose: "create",
      tunnelId: "atomic-revoke",
    });
    const beforeRevoke = await repository.findAccountById(administrator.principal.accountId);
    await service.revokeSessions(administrator.principal, administrator.principal.accountId);
    const afterRevoke = await repository.findAccountById(administrator.principal.accountId);
    assert.equal(afterRevoke?.authVersion, (beforeRevoke?.authVersion ?? 0) + 1);
    await assert.rejects(
      service.consumeCarrierCredential(carrierCredential),
      (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
    );

    administrator = await service.authenticate({
      username: "admin-one",
      password: "administrator-password-2026",
      remoteAddress: "192.0.2.1",
    });
    const target = await service.createAccount(administrator.principal, {
      username: "target-user",
      displayName: "Target User",
      roles: ["DEVELOPER"],
    });
    const roleChanged = await repository.setAccountRoles({
      accountId: target.account.id,
      roles: ["REVIEWER"],
      authorization: {
        accountId: administrator.principal.accountId,
        authVersion: administrator.principal.authVersion,
        requiredRole: "ADMIN",
      },
      updatedAt: now,
      auditEvent: {
        id: "role-change-audit",
        action: "ACCOUNT_ROLES_CHANGED",
        actorAccountId: administrator.principal.accountId,
        targetAccountId: target.account.id,
        occurredAt: now,
        metadata: {},
      },
    });
    assert.equal(roleChanged.status, "UPDATED");
    const passwordChanged = await repository.replaceAccountPassword({
      accountId: target.account.id,
      passwordHash: "hashed:new-password",
      mustChangePassword: true,
      expectedAuthVersion: roleChanged.status === "UPDATED"
        ? roleChanged.account.authVersion
        : target.account.authVersion,
      authorization: {
        accountId: administrator.principal.accountId,
        authVersion: administrator.principal.authVersion,
        requiredRole: "ADMIN",
      },
      updatedAt: now,
      auditEvent: {
        id: "password-change-audit",
        action: "PASSWORD_RESET",
        actorAccountId: administrator.principal.accountId,
        targetAccountId: target.account.id,
        occurredAt: now,
        metadata: {},
      },
    });
    assert.equal(passwordChanged.status, "UPDATED");
    assert.deepEqual((await repository.findAccountById(target.account.id))?.roles, ["REVIEWER"]);

    await Promise.all(Array.from({ length: 20 }, () => repository.recordLoginFailure({
      keys: ["identity-key", "remote-key"],
      now,
      windowStartsAt: new Date(now.getTime() - 15 * 60_000),
      lockThreshold: 5,
      lockedUntil: new Date(now.getTime() + 30_000),
      limits: { global: 100 },
    })));
    assert.equal((await repository.getLoginThrottle("identity-key"))?.failures, 20);
    assert.equal((await repository.getLoginThrottle("remote-key"))?.failures, 20);

    await service.createLoginIntent("one.preview.example", "/first");
    await service.createLoginIntent("one.preview.example", "/second");
    await assert.rejects(
      service.createLoginIntent("one.preview.example", "/third"),
      (error: unknown) => error instanceof AuthError && error.code === "LOGIN_INTENT_CAPACITY",
    );
    await service.createLoginIntent("two.preview.example", "/third");
    await assert.rejects(
      service.createLoginIntent("two.preview.example", "/fourth"),
      (error: unknown) => error instanceof AuthError && error.code === "LOGIN_INTENT_CAPACITY",
    );

    const secondAdmin = await service.createAccount(administrator.principal, {
      username: "admin-two",
      displayName: "Admin Two",
      roles: ["ADMIN"],
    });
    const removalResults = await Promise.allSettled([
      service.setAccountEnabled(administrator.principal, secondAdmin.account.id, false),
      service.setAccountEnabled(administrator.principal, administrator.principal.accountId, false),
    ]);
    assert.equal(removalResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await repository.countEnabledAdministrators(), 1);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'rt_login_intents'`,
    );
    assert.deepEqual(
      new Set(indexes.rows.map((row) => row.indexname)),
      new Set([
        "rt_login_intents_pkey",
        "rt_login_intents_expires_at_idx",
        "rt_login_intents_target_host_expires_at_idx",
      ]),
    );
    const throttleIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'rt_login_throttles'`,
    );
    assert.deepEqual(
      new Set(throttleIndexes.rows.map((row) => row.indexname)),
      new Set([
        "rt_login_throttles_pkey",
        "rt_login_throttles_updated_at_idx",
      ]),
    );
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL login throttle cap is atomic under concurrency and still updates existing keys", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_login_throttle_cap_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    options: `-c search_path=${schema}`,
  });
  try {
    const repository = new PostgresAuthRepository(pool);
    await repository.migrate();
    const now = new Date("2026-08-24T00:00:00.000Z");
    const limits = { global: 5 } as const;
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      repository.recordLoginFailure({
        keys: [`identity-${index}`],
        now,
        windowStartsAt: new Date(now.getTime() - 15 * 60_000),
        lockThreshold: 5,
        lockedUntil: new Date(now.getTime() + 30_000),
        limits,
      })));

    assert.equal(results.filter((result) => result.status === "RECORDED").length, 5);
    assert.equal(results.filter((result) => result.status === "CAPACITY_EXHAUSTED").length, 15);
    assert.equal(
      Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rt_login_throttles",
      )).rows[0]?.count),
      5,
    );

    const existing = await repository.recordLoginFailure({
      keys: ["identity-0"],
      now: new Date(now.getTime() + 1),
      windowStartsAt: new Date(now.getTime() - 15 * 60_000 + 1),
      lockThreshold: 5,
      lockedUntil: new Date(now.getTime() + 30_001),
      limits,
    });
    assert.equal(existing.status, "RECORDED");
    assert.equal((await repository.getLoginThrottle("identity-0"))?.failures, 2);

    const reclaimedAt = new Date(now.getTime() + 15 * 60_000 + 2);
    const reclaimed = await repository.recordLoginFailure({
      keys: ["identity-after-window"],
      now: reclaimedAt,
      windowStartsAt: new Date(reclaimedAt.getTime() - 15 * 60_000),
      lockThreshold: 5,
      lockedUntil: new Date(reclaimedAt.getTime() + 30_000),
      limits,
    });
    assert.equal(reclaimed.status, "RECORDED");
    assert.equal(
      Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rt_login_throttles",
      )).rows[0]?.count),
      5,
    );
    assert.equal(
      Number((await pool.query<{ count: string }>(
        `SELECT entry_count::text AS count
         FROM rt_login_throttle_capacity WHERE singleton = true`,
      )).rows[0]?.count),
      5,
    );
    assert.equal(await repository.deleteExpiredAuthArtifacts(reclaimedAt, 500), 4);
    assert.equal(
      Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rt_login_throttles",
      )).rows[0]?.count),
      1,
    );
    assert.equal(
      Number((await pool.query<{ count: string }>(
        `SELECT entry_count::text AS count
         FROM rt_login_throttle_capacity WHERE singleton = true`,
      )).rows[0]?.count),
      1,
    );
    for (let round = 0; round < 20; round += 1) {
      const keys = [`atomic-identity-${round}`, `atomic-remote-${round}`];
      const operationAt = new Date(reclaimedAt.getTime() + round + 1);
      await Promise.all([
        repository.deleteLoginThrottles(keys),
        repository.recordLoginFailure({
          keys,
          now: operationAt,
          windowStartsAt: new Date(operationAt.getTime() - 15 * 60_000),
          lockThreshold: 5,
          lockedUntil: new Date(operationAt.getTime() + 30_000),
          limits,
        }),
      ]);
      const stored = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM rt_login_throttles WHERE key = ANY($1::text[])`,
        [keys],
      );
      assert.ok(
        stored.rows[0]?.count === "0" || stored.rows[0]?.count === "2",
        "successful-login cleanup and failed-login recording split a throttle key pair",
      );
      const counts = await pool.query<{ rows: string; counter: string }>(
        `SELECT (SELECT count(*) FROM rt_login_throttles)::text AS rows,
                entry_count::text AS counter
         FROM rt_login_throttle_capacity WHERE singleton = true`,
      );
      assert.equal(counts.rows[0]?.counter, counts.rows[0]?.rows);
      await repository.deleteLoginThrottles(keys);
    }
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL audit hard cap is atomic while operational reserve protects emergency controls", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_audit_cap_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    options: `-c search_path=${schema}`,
  });
  const auditEventLimits = { global: 7, operationalReserve: 2 } as const;
  try {
    const repository = new PostgresAuthRepository(pool, { auditEventLimits });
    const operational = new PostgresOperationalStateRepository(pool, { auditEventLimits });
    await repository.migrate();
    const service = new AuthService({
      repository,
      passwordHasher: new FastTestHasher(),
      sessionHmacKey: Buffer.alloc(32, 41),
      dummyPasswordHash: "hashed:not-the-password",
      authenticationEventSink: { write() {}, reportFailure() {} },
    });
    const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
    const temporary = await service.authenticate({
      username: "admin",
      password: bootstrap.temporaryPassword,
      remoteAddress: "local-test",
    });
    await service.changeOwnPassword(temporary.principal, {
      currentPassword: bootstrap.temporaryPassword,
      newPassword: "administrator-password-2026",
    });
    const administrator = await service.authenticate({
      username: "admin",
      password: "administrator-password-2026",
      remoteAddress: "local-test",
    });

    const accountResults = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
      service.createAccount(administrator.principal, {
        username: `bounded-user-${index}`,
        displayName: `Bounded User ${index}`,
        roles: ["REVIEWER"],
      })));
    assert.equal(accountResults.filter((result) => result.status === "fulfilled").length, 3);
    assert.equal(
      accountResults.filter((result) =>
        result.status === "rejected" && result.reason instanceof AuditEventCapacityError).length,
      17,
    );
    assert.equal(
      Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rt_audit_events",
      )).rows[0]?.count),
      5,
    );
    assert.equal(
      Number((await pool.query<{ count: string }>(
        `SELECT event_count::text AS count
         FROM rt_audit_event_capacity WHERE singleton = true`,
      )).rows[0]?.count),
      5,
    );

    const identity = parseDeploymentIdentity(
      "audit-cap-deployment",
      `sha256:${"a".repeat(64)}`,
    );
    const actor = {
      accountId: administrator.principal.accountId,
      accountAuthVersion: administrator.principal.authVersion,
    };
    assert.equal((await operational.setKillSwitch(identity, true, actor, new Date())).killSwitchEnabled, true);
    assert.equal((await operational.setKillSwitch(identity, false, actor, new Date())).killSwitchEnabled, false);
    await assert.rejects(
      operational.setKillSwitch(identity, true, actor, new Date()),
      AuditEventCapacityError,
    );
    assert.equal((await operational.getOperationalState(identity)).killSwitchEnabled, false);
    assert.equal(
      Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rt_audit_events",
      )).rows[0]?.count),
      7,
    );
    assert.equal(
      Number((await pool.query<{ count: string }>(
        `SELECT event_count::text AS count
         FROM rt_audit_event_capacity WHERE singleton = true`,
      )).rows[0]?.count),
      7,
    );
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL rejects stale account artifacts after a concurrent revocation commits", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_auth_revoke_race_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const issuerPool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  const revokerPool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  let releaseSave: () => void = () => undefined;
  let markSaveStarted: () => void = () => undefined;
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  const saveReleased = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let capturedExchange: Parameters<PostgresAuthRepository["saveSessionExchange"]>[0] | undefined;
  class PausingPostgresAuthRepository extends PostgresAuthRepository {
    pauseNextExchangeSave = false;

    override async saveSessionExchange(
      ...arguments_: Parameters<PostgresAuthRepository["saveSessionExchange"]>
    ): Promise<boolean> {
      if (this.pauseNextExchangeSave) {
        this.pauseNextExchangeSave = false;
        capturedExchange = arguments_[0];
        markSaveStarted();
        await saveReleased;
      }
      return super.saveSessionExchange(...arguments_);
    }
  }

  try {
    const issuerRepository = new PausingPostgresAuthRepository(issuerPool);
    const revokerRepository = new PostgresAuthRepository(revokerPool);
    await issuerRepository.migrate();
    const now = new Date("2026-08-24T04:00:00.000Z");
    const account: Account = {
      id: "revoke-race-account",
      username: "revoke-race-account",
      displayName: "Revoke Race Account",
      roles: ["ADMIN", "DEVELOPER", "REVIEWER"],
      passwordHash: "hashed:revoke-race-password",
      enabled: true,
      mustChangePassword: false,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    assert.equal(await issuerRepository.createFirstAccount(account, {
      id: "revoke-race-bootstrap-audit",
      action: "ACCOUNT_BOOTSTRAPPED",
      targetAccountId: account.id,
      occurredAt: now,
      metadata: {},
    }), true);
    const sharedDependencies = {
      passwordHasher: new FastTestHasher(),
      sessionHmacKey: Buffer.alloc(32, 12),
      dummyPasswordHash: "hashed:not-the-password",
      authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
      now: () => now,
    } as const;
    let sequence = 0;
    const issuerService = new AuthService({
      ...sharedDependencies,
      repository: issuerRepository,
      createId: () => `revoke-race-id-${++sequence}`,
      createSecret: () => `revoke-race-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    });
    const revokerService = new AuthService({
      ...sharedDependencies,
      repository: revokerRepository,
    });
    const principal = {
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      roles: account.roles,
      mustChangePassword: account.mustChangePassword,
      authVersion: account.authVersion,
      sessionId: "revoke-race-control-session",
    } as const;
    const intent = await issuerService.createLoginIntent("revoke-race.preview.example", "/review");
    issuerRepository.pauseNextExchangeSave = true;
    const exchangeCreation = issuerService.createSessionExchange(principal, intent);
    await saveStarted;

    await revokerService.revokeSessions(principal, account.id);
    releaseSave();

    await assert.rejects(exchangeCreation, AuthError);
    assert.ok(capturedExchange !== undefined);
    const current = await issuerRepository.findAccountById(account.id);
    assert.equal(current?.authVersion, account.authVersion + 1);
    const limits = { global: 8, perAccount: 8 } as const;
    const staleResults = await Promise.all([
      issuerRepository.saveSession({
        id: "revoke-race-stale-session",
        tokenDigest: "revoke-race-stale-session-digest",
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        audience: "control",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }, now, limits),
      issuerRepository.saveSessionExchange(capturedExchange, now, limits),
      issuerRepository.saveCarrierCredential({
        id: "revoke-race-stale-carrier",
        secretDigest: "revoke-race-stale-carrier-digest",
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        purpose: "create",
        tunnelId: "revoke-race-tunnel",
        expiresAt: new Date(now.getTime() + 60_000),
      }, now, limits),
    ]);
    assert.deepEqual(staleResults, [false, false, false]);
    const artifactCounts = await issuerPool.query<{
      sessions: string;
      exchanges: string;
      credentials: string;
    }>(
      `SELECT (SELECT count(*) FROM rt_auth_sessions)::text AS sessions,
              (SELECT count(*) FROM rt_session_exchanges)::text AS exchanges,
              (SELECT count(*) FROM rt_carrier_credentials)::text AS credentials`,
    );
    assert.deepEqual(artifactCounts.rows[0], {
      sessions: "0",
      exchanges: "0",
      credentials: "0",
    });
  } finally {
    releaseSave();
    await issuerPool.end();
    await revokerPool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL migrates a legacy login throttle table before indexing updated_at", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_auth_legacy_throttle_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(
      `CREATE TABLE rt_login_throttles (
         key text PRIMARY KEY,
         failures integer NOT NULL CHECK (failures > 0),
         locked_until timestamptz
       )`,
    );
    await pool.query(
      "INSERT INTO rt_login_throttles(key, failures, locked_until) VALUES ('legacy', 2, NULL)",
    );

    await new PostgresAuthRepository(pool).migrate();

    const row = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM rt_login_throttles WHERE key = 'legacy'",
    );
    assert.ok(row.rows[0]?.updated_at instanceof Date);
    const column = await pool.query<{ is_nullable: "YES" | "NO" }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'rt_login_throttles'
         AND column_name = 'updated_at'`,
    );
    assert.equal(column.rows[0]?.is_nullable, "NO");
    const index = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'rt_login_throttles'
         AND indexname = 'rt_login_throttles_updated_at_idx'`,
    );
    assert.equal(index.rowCount, 1);
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});

test("PostgreSQL bounds stored auth artifacts atomically across concurrent issuers", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_auth_capacity_${randomBytes(8).toString("hex")}`;
  const administratorPool = new Pool({ connectionString: databaseUrl, max: 1 });
  await administratorPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 20,
    options: `-c search_path=${schema}`,
  });
  try {
    const repository = new PostgresAuthRepository(pool);
    await repository.migrate();
    const now = new Date("2026-08-24T03:00:00.000Z");
    const account: Account = {
      id: "capacity-account",
      username: "capacity-account",
      displayName: "Capacity Account",
      roles: ["ADMIN", "DEVELOPER", "REVIEWER"],
      passwordHash: "hashed:capacity-password",
      enabled: true,
      mustChangePassword: false,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    assert.equal(await repository.createFirstAccount(account, {
      id: "capacity-bootstrap-audit",
      action: "ACCOUNT_BOOTSTRAPPED",
      targetAccountId: account.id,
      occurredAt: now,
      metadata: {},
    }), true);
    const limits = { global: 3, perAccount: 2 } as const;

    const sessionResults = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      repository.saveSession({
        id: `capacity-session-${index}`,
        tokenDigest: `capacity-session-digest-${index}`,
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        audience: "control",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }, now, limits)));
    assert.equal(sessionResults.filter(Boolean).length, 2);

    const exchangeResults = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      repository.saveSessionExchange({
        codeDigest: `capacity-exchange-${index}`,
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        targetHost: "capacity.preview.example",
        targetPath: "/",
        expiresAt: new Date(now.getTime() + 60_000),
      }, now, limits)));
    assert.equal(exchangeResults.filter(Boolean).length, 2);

    const credentialResults = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      repository.saveCarrierCredential({
        id: `capacity-credential-${index}`,
        secretDigest: `capacity-credential-digest-${index}`,
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        purpose: "create",
        tunnelId: `capacity-tunnel-${index}`,
        expiresAt: new Date(now.getTime() + 60_000),
      }, now, limits)));
    assert.equal(credentialResults.filter(Boolean).length, 2);

    const expiredAt = new Date(now.getTime() - 1);
    await pool.query("UPDATE rt_auth_sessions SET expires_at = $1", [expiredAt]);
    await pool.query("UPDATE rt_session_exchanges SET expires_at = $1", [expiredAt]);
    await pool.query("UPDATE rt_carrier_credentials SET expires_at = $1", [expiredAt]);
    await pool.query(
      `INSERT INTO rt_auth_sessions
       (id, token_digest, account_id, account_auth_version, audience, created_at, expires_at, last_seen_at)
       SELECT 'expired-capacity-session-' || value,
              'expired-capacity-session-digest-' || value,
              $1, $2, 'control', $3, $4, $3
       FROM generate_series(1, 499) AS value`,
      [account.id, account.authVersion, now, expiredAt],
    );
    await pool.query(
      `INSERT INTO rt_session_exchanges
       (code_digest, account_id, account_auth_version, target_host, target_path, expires_at)
       SELECT 'expired-capacity-exchange-' || value,
              $1, $2, 'capacity.preview.example', '/', $3
       FROM generate_series(1, 499) AS value`,
      [account.id, account.authVersion, expiredAt],
    );
    await pool.query(
      `INSERT INTO rt_carrier_credentials
       (id, secret_digest, account_id, account_auth_version, purpose, tunnel_id, expires_at)
       SELECT 'expired-capacity-credential-' || value,
              'expired-capacity-credential-digest-' || value,
              $1, $2, 'create', 'expired-capacity-tunnel-' || value, $3
       FROM generate_series(1, 499) AS value`,
      [account.id, account.authVersion, expiredAt],
    );
    const backlogLimits = { global: 1, perAccount: 1 } as const;
    const liveExpiry = new Date(now.getTime() + 120_000);
    const backlogResults = await Promise.all([
      repository.saveSession({
        id: "post-backlog-session",
        tokenDigest: "post-backlog-session-digest",
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        audience: "control",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: liveExpiry,
      }, now, backlogLimits),
      repository.saveSessionExchange({
        codeDigest: "post-backlog-exchange",
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        targetHost: "capacity.preview.example",
        targetPath: "/",
        expiresAt: liveExpiry,
      }, now, backlogLimits),
      repository.saveCarrierCredential({
        id: "post-backlog-credential",
        secretDigest: "post-backlog-credential-digest",
        accountId: account.id,
        accountAuthVersion: account.authVersion,
        purpose: "create",
        tunnelId: "post-backlog-tunnel",
        expiresAt: liveExpiry,
      }, now, backlogLimits),
    ]);
    assert.deepEqual(backlogResults, [true, true, true]);
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});
