import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

import { Argon2idPasswordHasher, AuthService } from "../../auth/src/index.ts";
import { OperationalStateError, parseDeploymentIdentity } from "../../operations/src/index.ts";
import { PostgresAuthRepository } from "./postgres-auth-repository.ts";
import { PostgresOperationalStateRepository } from "./postgres-operational-state-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

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
    });
    assert.equal((await restartedService.resolveSession(login.sessionToken))?.username, "admin");

    const identity = parseDeploymentIdentity("release-42", `sha256:${"c".repeat(64)}`);
    const operational = new PostgresOperationalStateRepository(pool);
    assert.equal((await operational.getOperationalState(identity)).canaryStatus, "UNKNOWN");
    await assert.rejects(
      operational.approveAdmission(identity, stored?.id ?? "", new Date()),
      (error: unknown) =>
        error instanceof OperationalStateError && error.code === "CANARY_REQUIRED",
    );
    const canary = await operational.recordCanaryResult(
      identity,
      "PASSED",
      stored?.id ?? "",
      new Date(),
    );
    assert.equal(canary.admissionApprovedAt, undefined);
    const approved = await operational.approveAdmission(
      identity,
      stored?.id ?? "",
      new Date(),
    );
    assert.ok(approved.admissionApprovedAt instanceof Date);
    const restartedOperational = new PostgresOperationalStateRepository(pool);
    assert.ok((await restartedOperational.getOperationalState(identity)).admissionApprovedAt);
    const failed = await operational.recordCanaryResult(
      identity,
      "FAILED",
      stored?.id ?? "",
      new Date(),
    );
    assert.equal(failed.admissionApprovedAt, undefined);
    await operational.recordCanaryResult(
      identity,
      "PASSED",
      stored?.id ?? "",
      new Date(),
    );
    await operational.approveAdmission(identity, stored?.id ?? "", new Date());
    const killed = await operational.setKillSwitch(
      identity,
      true,
      stored?.id ?? "",
      new Date(),
    );
    assert.equal(killed.killSwitchEnabled, true);
    assert.equal(killed.canaryStatus, "UNKNOWN");
    assert.equal(killed.admissionApprovedAt, undefined);
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});
