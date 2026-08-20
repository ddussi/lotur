import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_POLICY,
  getSessionDeadline,
  isResumeAllowed,
} from "./session-policy.ts";

const minute = 60_000;
const hour = 60 * minute;

test("기본 Session 정책은 8시간, 30분, 2분이다", () => {
  assert.deepEqual(DEFAULT_SESSION_POLICY, {
    maxTtlMs: 8 * hour,
    idleTimeoutMs: 30 * minute,
    reconnectGraceMs: 2 * minute,
  });
});

test("열린 Stream이 있으면 idle deadline 대신 max TTL을 사용한다", () => {
  const activatedAt = 1_000;

  assert.equal(
    getSessionDeadline({
      activatedAt,
      lastStreamClosedAt: activatedAt + hour,
      activeStreamCount: 1,
      policy: DEFAULT_SESSION_POLICY,
    }),
    activatedAt + 8 * hour,
  );
});

test("Stream이 없으면 max TTL과 idle deadline 중 이른 값을 사용한다", () => {
  const activatedAt = 1_000;
  const lastStreamClosedAt = activatedAt + hour;

  assert.equal(
    getSessionDeadline({
      activatedAt,
      lastStreamClosedAt,
      activeStreamCount: 0,
      policy: DEFAULT_SESSION_POLICY,
    }),
    lastStreamClosedAt + 30 * minute,
  );
});

test("재연결은 2분 경계 직전과 경계에서만 허용한다", () => {
  const disconnectedAt = 10_000;

  assert.equal(
    isResumeAllowed(disconnectedAt + 2 * minute, disconnectedAt),
    true,
  );
  assert.equal(
    isResumeAllowed(disconnectedAt + 2 * minute + 1, disconnectedAt),
    false,
  );
});

