import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { waitForWritableDrain } from "./writable-drain.ts";

test("drain waiter는 drain에서 resolve하고 close/error listener를 정리한다", async () => {
  const writable = new EventEmitter();
  const draining = waitForWritableDrain(writable);

  writable.emit("drain");

  await draining;
  assert.equal(writable.listenerCount("drain"), 0);
  assert.equal(writable.listenerCount("close"), 0);
  assert.equal(writable.listenerCount("error"), 0);
});

test("drain waiter는 close에서 reject하고 모든 listener를 정리한다", async () => {
  const writable = new PassThrough({ highWaterMark: 1 });
  assert.equal(writable.write(Buffer.alloc(2)), false);

  const draining = waitForWritableDrain(writable);
  writable.destroy();

  await assert.rejects(draining, /closed before drain/);
  assert.equal(writable.listenerCount("drain"), 0);
  assert.equal(writable.listenerCount("close"), 0);
  assert.equal(writable.listenerCount("error"), 0);
});

test("drain waiter는 error 원인을 보존하고 다른 listener를 정리한다", async () => {
  const writable = new PassThrough({ highWaterMark: 1 });
  const draining = waitForWritableDrain(writable);
  const failure = new Error("write failed");
  writable.destroy(failure);

  await assert.rejects(draining, failure);
  assert.equal(writable.listenerCount("drain"), 0);
  assert.equal(writable.listenerCount("close"), 0);
  assert.equal(writable.listenerCount("error"), 0);
});
