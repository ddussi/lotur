import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

import { Argon2idPasswordHasher, AuthService } from "../../auth/src/index.ts";
import { PostgresAuthRepository } from "./postgres-auth-repository.ts";

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
  } finally {
    await pool.end();
    await administratorPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await administratorPool.end();
  }
});
