import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

import { withTransaction } from "./postgres-transaction.ts";

test("PostgreSQL transaction은 성공하면 commit한 뒤 client를 반환한다", async () => {
  const calls: string[] = [];
  const client = transactionClient(calls);
  const database = { connect: async () => client } as unknown as Pool;

  const result = await withTransaction(database, async (connected) => {
    assert.equal(connected, client);
    calls.push("work");
    return "done";
  });

  assert.equal(result, "done");
  assert.deepEqual(calls, ["BEGIN", "work", "COMMIT", "release"]);
});

test("PostgreSQL transaction은 실패하면 rollback하고 원인을 보존한다", async () => {
  const calls: string[] = [];
  const client = transactionClient(calls);
  const database = { connect: async () => client } as unknown as Pool;
  const failure = new Error("work failed");

  await assert.rejects(
    withTransaction(database, async () => {
      calls.push("work");
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["BEGIN", "work", "ROLLBACK", "release"]);
});

for (const stage of ["BEGIN", "work", "COMMIT"]) {
  for (const rollbackFails of [false, true]) {
    test(`PostgreSQL ${stage} 실패와 rollback 실패=${rollbackFails}의 원인과 연결 해제를 보존한다`, async () => {
      const calls: string[] = [];
      const failure = new Error(`${stage} failed`);
      const rollbackFailure = new Error("rollback failed");
      const client = {
        async query(command: string) {
          calls.push(command);
          if (command === stage) throw failure;
          if (command === "ROLLBACK" && rollbackFails) throw rollbackFailure;
          return { rows: [], rowCount: 0 };
        },
        release(destroy?: boolean) {
          calls.push(destroy === true ? "destroy" : "release");
        },
      } as unknown as PoolClient;
      const database = { connect: async () => client } as unknown as Pool;

      await assert.rejects(withTransaction(database, async () => {
        calls.push("work");
        if (stage === "work") throw failure;
      }), (error) => {
        if (!rollbackFails) return error === failure;
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, failure);
        assert.deepEqual(error.errors, [failure, rollbackFailure]);
        return true;
      });
      assert.deepEqual(calls, [
        "BEGIN",
        ...(stage === "BEGIN" ? [] : ["work"]),
        ...(stage === "COMMIT" ? ["COMMIT"] : []),
        "ROLLBACK",
        rollbackFails ? "destroy" : "release",
      ]);
    });
  }
}

test("snapshot transaction은 읽기 전용 repeatable read를 사용한다", async () => {
  const calls: string[] = [];
  const database = { connect: async () => transactionClient(calls) } as unknown as Pool;
  assert.equal(await withTransaction(database, async () => 42, "snapshot"), 42);
  assert.deepEqual(calls, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "release"]);
});

function transactionClient(calls: string[]): PoolClient {
  return {
    async query(command: string) {
      calls.push(command);
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push("release");
    },
  } as unknown as PoolClient;
}
