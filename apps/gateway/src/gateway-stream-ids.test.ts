import assert from "node:assert/strict";
import test from "node:test";

import { GatewayStreamIds } from "./gateway-stream-ids.ts";

test("issued stream high-water는 개별 tombstone 없이 오래된 ID를 판별한다", () => {
  const streamIds = new GatewayStreamIds();
  for (let index = 0; index < 10_000; index += 1) streamIds.issue();

  assert.equal(streamIds.wasIssued(1), true);
  assert.equal(streamIds.wasIssued(8_193), true);
  assert.equal(streamIds.wasIssued(19_999), true);
  assert.equal(streamIds.wasIssued(20_001), false);
  assert.equal(streamIds.wasIssued(2), false);
  assert.equal(streamIds.wasIssued(0), false);
});

test("새 generation은 stream ID high-water를 1부터 다시 시작한다", () => {
  const streamIds = new GatewayStreamIds();
  assert.equal(streamIds.issue(), 1);
  assert.equal(streamIds.issue(), 3);
  streamIds.reset();
  assert.equal(streamIds.wasIssued(3), false);
  assert.equal(streamIds.issue(), 1);
});
