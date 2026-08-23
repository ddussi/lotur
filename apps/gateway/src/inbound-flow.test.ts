import assert from "node:assert/strict";
import test from "node:test";

import { GatewayInboundFlow, GatewayInboundFlowError } from "./inbound-flow.ts";

test("여러 Stream의 receive credit 합계가 connection window를 넘지 않는다", () => {
  const flow = new GatewayInboundFlow(10);
  flow.openStream(1, 10);
  flow.openStream(3, 10);
  flow.consume(1, 6);
  assert.throws(() => flow.consume(3, 5), GatewayInboundFlowError);
  flow.consume(3, 4);
});

test("소비한 credit은 WINDOW_UPDATE와 Stream close에서 정확히 복구한다", () => {
  const flow = new GatewayInboundFlow(10);
  flow.openStream(1, 8);
  flow.openStream(3, 8);
  flow.consume(1, 7);
  flow.release(1, 4);
  flow.consume(3, 7);
  flow.closeStream(1);
  flow.consume(3, 1);
  assert.throws(() => flow.release(3, 9), GatewayInboundFlowError);
});

test("local reset 당시 남은 stream/connection credit만 retired DATA에 이전한다", () => {
  const flow = new GatewayInboundFlow(8, 8);
  flow.openStream(1, 6);
  flow.consume(1, 2);
  flow.retireStream(1);

  flow.consumeRetiredData(1, 4);
  assert.throws(() => flow.consumeRetiredData(1, 1), /byte budget/);
});
