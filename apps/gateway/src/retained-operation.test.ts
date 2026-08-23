import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { retainAdmissionUntilSettled } from "./retained-operation.ts";

test("response deadline does not release admission before the operation settles", async () => {
  let settle!: () => void;
  const held = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let releases = 0;
  const operation = retainAdmissionUntilSettled(held, () => {
    releases += 1;
  });

  await Promise.race([operation, delay(5)]);
  assert.equal(releases, 0);

  settle();
  await operation;
  assert.equal(releases, 1);
});

test("rejected operations release retained admission exactly once", async () => {
  let reject!: (error: Error) => void;
  const held = new Promise<void>((_resolve, rejectOperation) => {
    reject = rejectOperation;
  });
  let releases = 0;
  const operation = retainAdmissionUntilSettled(held, () => {
    releases += 1;
  });

  reject(new Error("expected failure"));
  await assert.rejects(operation, /expected failure/);
  assert.equal(releases, 1);
});
