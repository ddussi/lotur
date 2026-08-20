import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_SESSION_STATE,
  SessionTransitionError,
  transitionSession,
  type SessionState,
} from "./session-state.ts";

const minute = 60_000;
const hour = 60 * minute;

function active(now = 0): SessionState {
  return transitionSession(INITIAL_SESSION_STATE, { type: "ACTIVATE", now });
}

test("Session은 CREATING에서 generation 1 ACTIVE로만 활성화된다", () => {
  assert.deepEqual(active(100), {
    status: "ACTIVE",
    activatedAt: 100,
    generation: 1,
    activeStreamCount: 0,
    lastStreamClosedAt: 100,
  });
});

test("Carrier 단절은 열린 Stream을 종료하고 RECONNECTING으로 전이한다", () => {
  const withStream = transitionSession(active(), { type: "STREAM_OPEN", now: 1 });
  assert.deepEqual(
    transitionSession(withStream, { type: "CARRIER_LOST", now: 2 }),
    {
      status: "RECONNECTING",
      activatedAt: 0,
      generation: 1,
      disconnectedAt: 2,
      lastStreamClosedAt: 2,
    },
  );
});

test("동시에 하나의 resume candidate만 허용하고 일치하는 attempt만 commit한다", () => {
  const reconnecting = transitionSession(active(), { type: "CARRIER_LOST", now: 10 });
  const candidate = transitionSession(reconnecting, {
    type: "START_RESUME",
    now: 11,
    attemptId: "candidate-a",
  });
  assert.throws(
    () =>
      transitionSession(candidate, {
        type: "START_RESUME",
        now: 12,
        attemptId: "candidate-b",
      }),
    (error: unknown) =>
      error instanceof SessionTransitionError && error.code === "RESUME_IN_PROGRESS",
  );
  assert.throws(
    () =>
      transitionSession(candidate, {
        type: "RESUME_COMMITTED",
        now: 12,
        attemptId: "candidate-b",
      }),
    (error: unknown) =>
      error instanceof SessionTransitionError && error.code === "STALE_RESUME_ATTEMPT",
  );
});

test("2분 경계의 resume은 허용하고 generation만 증가시킨다", () => {
  const reconnecting = transitionSession(active(1_000), {
    type: "CARRIER_LOST",
    now: 2_000,
  });
  const candidate = transitionSession(reconnecting, {
    type: "START_RESUME",
    now: 2_000 + 2 * minute,
    attemptId: "candidate-a",
  });
  const resumed = transitionSession(candidate, {
    type: "RESUME_COMMITTED",
    now: 2_000 + 2 * minute,
    attemptId: "candidate-a",
  });
  assert.equal(resumed.status, "ACTIVE");
  if (resumed.status === "ACTIVE") {
    assert.equal(resumed.generation, 2);
    assert.equal(resumed.activatedAt, 1_000);
  }
});

test("재연결은 최대 TTL을 초기화하지 않는다", () => {
  const reconnecting = transitionSession(active(), {
    type: "CARRIER_LOST",
    now: 7 * hour,
  });
  const candidate = transitionSession(reconnecting, {
    type: "START_RESUME",
    now: 7 * hour + minute,
    attemptId: "candidate-a",
  });
  const resumed = transitionSession(candidate, {
    type: "RESUME_COMMITTED",
    now: 7 * hour + minute,
    attemptId: "candidate-a",
  });
  assert.deepEqual(
    transitionSession(resumed, { type: "TICK", now: 8 * hour }),
    { status: "EXPIRED", reason: "MAX_TTL", closedAt: 8 * hour },
  );
});

test("열린 Stream은 idle 만료를 막지만 8시간 최대 TTL은 막지 않는다", () => {
  const withStream = transitionSession(active(), { type: "STREAM_OPEN", now: 1 });
  assert.equal(
    transitionSession(withStream, { type: "TICK", now: 31 * minute }).status,
    "ACTIVE",
  );
  assert.deepEqual(
    transitionSession(withStream, { type: "TICK", now: 8 * hour }),
    { status: "EXPIRED", reason: "MAX_TTL", closedAt: 8 * hour },
  );
});

test("마지막 Stream 종료 후 정확히 30분에 IDLE_TIMEOUT이 된다", () => {
  const opened = transitionSession(active(), { type: "STREAM_OPEN", now: minute });
  const closed = transitionSession(opened, {
    type: "STREAM_CLOSED",
    now: 2 * minute,
  });
  assert.deepEqual(
    transitionSession(closed, { type: "TICK", now: 32 * minute }),
    { status: "EXPIRED", reason: "IDLE_TIMEOUT", closedAt: 32 * minute },
  );
});

test("실패한 resume candidate를 제거하면 다음 candidate가 시작할 수 있다", () => {
  const reconnecting = transitionSession(active(), { type: "CARRIER_LOST", now: 10 });
  const first = transitionSession(reconnecting, {
    type: "START_RESUME",
    now: 11,
    attemptId: "candidate-a",
  });
  const failed = transitionSession(first, {
    type: "RESUME_FAILED",
    attemptId: "candidate-a",
  });
  const second = transitionSession(failed, {
    type: "START_RESUME",
    now: 12,
    attemptId: "candidate-b",
  });
  assert.equal(
    second.status === "RECONNECTING" ? second.candidateAttemptId : undefined,
    "candidate-b",
  );
});

test("재연결 유예를 1ms 넘기면 RECONNECT_TIMEOUT이 된다", () => {
  const reconnecting = transitionSession(active(), { type: "CARRIER_LOST", now: 1_000 });
  assert.deepEqual(
    transitionSession(reconnecting, {
      type: "TICK",
      now: 1_000 + 2 * minute + 1,
    }),
    {
      status: "EXPIRED",
      reason: "RECONNECT_TIMEOUT",
      closedAt: 1_000 + 2 * minute + 1,
    },
  );
});
