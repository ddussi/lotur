import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

import type { Account, AuditEvent } from "../../auth/src/index.ts";
import { PostgresAuthRepository } from "./postgres-auth-repository.ts";

const now = new Date("2026-10-09T00:00:00Z");
const account: Account = {
  id: "admin-id", username: "admin", displayName: "Admin", roles: ["ADMIN"],
  passwordHash: "test-hash", enabled: true, mustChangePassword: true,
  authVersion: 1, createdAt: now, updatedAt: now,
};
const event: AuditEvent = {
  id: "audit-id", action: "ACCOUNT_BOOTSTRAPPED", occurredAt: now, metadata: {},
};

for (const scenario of ["exists", "success", "audit failure", "double failure"] as const) {
  test(`첫 관리자 생성은 lock과 원자성을 보존한다: ${scenario}`, async () => {
    const calls: string[] = [];
    const failure = new Error("audit failed");
    const rollbackFailure = new Error("rollback failed");
    const client = {
      async query(sql: string, values?: unknown[]) {
        let operation = sql;
        if (sql.includes("pg_advisory_xact_lock")) operation = `lock:${values?.[0]}`;
        else if (sql.includes("count(*)")) operation = "count";
        else if (sql.includes("INSERT INTO rt_accounts")) operation = "account";
        else if (sql.includes("UPDATE rt_audit_event_capacity")) operation = "audit capacity";
        else if (sql.includes("INSERT INTO rt_audit_events")) operation = "audit";
        calls.push(operation);
        if (operation === "audit" && scenario.includes("failure")) throw failure;
        if (operation === "ROLLBACK" && scenario === "double failure") throw rollbackFailure;
        return { rows: [{ count: scenario === "exists" ? "1" : "0" }], rowCount: 1 };
      },
      release(destroy?: boolean) { calls.push(destroy ? "destroy" : "release"); },
    } as unknown as PoolClient;
    const repository = new PostgresAuthRepository({ connect: async () => client } as unknown as Pool);
    if (scenario.includes("failure")) {
      await assert.rejects(repository.createFirstAccount(account, event), (error) => {
        if (scenario === "audit failure") return error === failure;
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, failure);
        assert.deepEqual(error.errors, [failure, rollbackFailure]);
        return true;
      });
    } else {
      assert.equal(await repository.createFirstAccount(account, event), scenario === "success");
    }
    assert.deepEqual(calls.slice(0, 3), ["BEGIN", "lock:1467289113", "count"]);
    if (scenario === "exists") {
      assert.deepEqual(calls.slice(3), ["COMMIT", "release"]);
    } else {
      assert.equal(calls[3], "account");
      assert.match(calls[4] ?? "", /^lock:/);
      assert.deepEqual(calls.slice(5), [
        "audit capacity", "audit", scenario.includes("failure") ? "ROLLBACK" : "COMMIT",
        scenario === "double failure" ? "destroy" : "release",
      ]);
    }
  });
}
