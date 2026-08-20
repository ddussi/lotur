import assert from "node:assert/strict";
import test from "node:test";

import { FlowWindowError, OutboundFlowWindow } from "./flow-window.ts";

test("Stream과 connection credit 중 작은 값만 DATA에 부여한다", async () => {
  const window = new OutboundFlowWindow(10);
  window.openStream(1, 6);
  assert.equal(await window.take(1, 20), 6);

  let resolved = false;
  const waiting = window.take(1, 1).then((value) => {
    resolved = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(resolved, false);

  window.update(1, 3);
  assert.equal(await waiting, 1);
});

test("소비하지 않은 byte보다 큰 WINDOW_UPDATE는 거부한다", async () => {
  const window = new OutboundFlowWindow(10);
  window.openStream(1, 10);
  await window.take(1, 4);
  assert.throws(() => window.update(1, 5), FlowWindowError);
});

test("Stream reset은 미반환 connection credit을 회수한다", async () => {
  const window = new OutboundFlowWindow(4);
  window.openStream(1, 4);
  window.openStream(3, 4);
  await window.take(1, 4);

  const waiting = window.take(3, 4);
  window.closeStream(1);
  assert.equal(await waiting, 4);
});

