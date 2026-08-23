import assert from "node:assert/strict";
import test from "node:test";

import { InboundFlowError, InboundFlowWindow } from "./inbound-flow.ts";

test("Stream과 connection 수신 credit을 소비하고 처리 완료 후에만 반환한다", () => {
  const window = new InboundFlowWindow(8);
  window.openStream(1, 6);
  window.openStream(3, 6);

  window.consume(1, 6);
  assert.throws(() => window.consume(1, 1), InboundFlowError);
  assert.throws(() => window.consume(3, 3), InboundFlowError);

  window.release(1, 6);
  window.consume(3, 6);
  window.release(3, 6);
});

test("작은 DATA frame Promise 수와 reset 시 미반환 connection credit도 bounded한다", () => {
  const window = new InboundFlowWindow(10, 2);
  window.openStream(1, 10);
  window.consume(1, 1);
  window.consume(1, 1);
  assert.throws(() => window.consume(1, 1), /too many pending/);

  window.closeStream(1);
  window.openStream(3, 10);
  window.consume(3, 10);
  window.release(3, 10);
});

test("local reset 당시 남은 stream/connection credit만 retired DATA에 이전한다", () => {
  const window = new InboundFlowWindow(8, 8);
  window.openStream(1, 6);
  window.consume(1, 2);
  window.retireStream(1);

  window.consumeRetiredData(1, 4);
  assert.throws(() => window.consumeRetiredData(1, 1), /byte budget/);
});
