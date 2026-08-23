import assert from "node:assert/strict";
import test from "node:test";

import {
  RemoteStreamLifecycle,
  RemoteStreamLifecycleError,
} from "./remote-stream-lifecycle.ts";

test("gateway stream ID는 1부터 홀수 순차 증가이고 종료 후 retired가 된다", () => {
  const lifecycle = new RemoteStreamLifecycle();
  assert.throws(() => lifecycle.open(2), RemoteStreamLifecycleError);
  assert.throws(() => lifecycle.open(3), /expected 1/);
  lifecycle.open(1);
  lifecycle.close(1);
  assert.equal(lifecycle.isRetired(1), true);
  assert.throws(() => lifecycle.requireActive(1), /retired/);
  assert.throws(() => lifecycle.open(1), /reused or reordered/);
  assert.throws(() => lifecycle.open(5), /expected 3/);
  lifecycle.open(3);
});

test("종료 직후 지연 도착한 WINDOW_UPDATE를 위한 retired 판정을 노출한다", () => {
  const lifecycle = new RemoteStreamLifecycle();
  lifecycle.open(1);
  lifecycle.close(1);
  assert.equal(lifecycle.isRetired(1), true);
  assert.equal(lifecycle.isRetired(3), false);
});

test("아직 OPEN되지 않은 stream frame은 거부한다", () => {
  const lifecycle = new RemoteStreamLifecycle();
  assert.throws(() => lifecycle.requireActive(9), /unknown/);
});

test("오래된 retired ID는 개별 tombstone 없이도 판별한다", () => {
  const lifecycle = new RemoteStreamLifecycle();
  for (let streamId = 1; streamId <= 10_001; streamId += 2) {
    lifecycle.open(streamId);
    lifecycle.close(streamId);
  }
  assert.equal(lifecycle.isRetired(1), true);
  assert.equal(lifecycle.isRetired(9_999), true);
  assert.equal(lifecycle.isRetired(10_002), false);
  assert.equal(lifecycle.isRetired(10_003), false);
  assert.throws(() => lifecycle.requireActive(1), /retired/);
  assert.throws(() => lifecycle.requireActive(10_002), /unknown/);
  assert.throws(() => lifecycle.requireActive(10_003), /unknown/);
  assert.throws(() => lifecycle.open(1), /reused or reordered/);
});
