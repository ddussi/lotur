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
