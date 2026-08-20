import {
  DEFAULT_SESSION_POLICY,
  getSessionDeadline,
  isResumeAllowed,
  type SessionPolicy,
} from "./session-policy.ts";

export type CloseReason =
  | "USER_REQUEST"
  | "MAX_TTL"
  | "IDLE_TIMEOUT"
  | "RECONNECT_TIMEOUT";

export type SessionState =
  | Readonly<{ status: "CREATING" }>
  | Readonly<{
      status: "ACTIVE";
      activatedAt: number;
      generation: number;
      activeStreamCount: number;
      lastStreamClosedAt: number;
    }>
  | Readonly<{
      status: "RECONNECTING";
      activatedAt: number;
      generation: number;
      disconnectedAt: number;
      lastStreamClosedAt: number;
      candidateAttemptId?: string;
    }>
  | Readonly<{
      status: "EXPIRED";
      reason: CloseReason;
      closedAt: number;
    }>
  | Readonly<{
      status: "CLOSED";
      reason: CloseReason;
      closedAt: number;
    }>;

export type SessionEvent =
  | Readonly<{ type: "ACTIVATE"; now: number }>
  | Readonly<{ type: "STREAM_OPEN"; now: number }>
  | Readonly<{ type: "STREAM_CLOSED"; now: number }>
  | Readonly<{ type: "CARRIER_LOST"; now: number }>
  | Readonly<{ type: "START_RESUME"; now: number; attemptId: string }>
  | Readonly<{ type: "RESUME_FAILED"; attemptId: string }>
  | Readonly<{ type: "RESUME_COMMITTED"; now: number; attemptId: string }>
  | Readonly<{ type: "TICK"; now: number }>
  | Readonly<{ type: "CLOSE"; now: number }>;

export type SessionTransitionErrorCode =
  | "INVALID_TRANSITION"
  | "RESUME_IN_PROGRESS"
  | "STALE_RESUME_ATTEMPT";

export class SessionTransitionError extends Error {
  readonly code: SessionTransitionErrorCode;

  constructor(code: SessionTransitionErrorCode, message: string) {
    super(message);
    this.name = "SessionTransitionError";
    this.code = code;
  }
}

export const INITIAL_SESSION_STATE: SessionState = Object.freeze({
  status: "CREATING",
});

export function transitionSession(
  state: SessionState,
  event: SessionEvent,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): SessionState {
  if (state.status === "EXPIRED" || state.status === "CLOSED") {
    throw invalid(state, event);
  }

  if (event.type === "CLOSE") {
    return { status: "CLOSED", reason: "USER_REQUEST", closedAt: event.now };
  }

  if (state.status === "CREATING") {
    if (event.type !== "ACTIVATE") throw invalid(state, event);
    return {
      status: "ACTIVE",
      activatedAt: event.now,
      generation: 1,
      activeStreamCount: 0,
      lastStreamClosedAt: event.now,
    };
  }

  if (state.status === "ACTIVE") {
    switch (event.type) {
      case "STREAM_OPEN":
        return { ...state, activeStreamCount: state.activeStreamCount + 1 };
      case "STREAM_CLOSED":
        if (state.activeStreamCount === 0) throw invalid(state, event);
        return {
          ...state,
          activeStreamCount: state.activeStreamCount - 1,
          lastStreamClosedAt:
            state.activeStreamCount === 1 ? event.now : state.lastStreamClosedAt,
        };
      case "CARRIER_LOST":
        return {
          status: "RECONNECTING",
          activatedAt: state.activatedAt,
          generation: state.generation,
          disconnectedAt: event.now,
          lastStreamClosedAt: event.now,
        };
      case "TICK":
        return expireActiveIfNeeded(state, event.now, policy);
      default:
        throw invalid(state, event);
    }
  }

  switch (event.type) {
    case "START_RESUME":
      if (!isResumeAllowed(event.now, state.disconnectedAt, policy)) {
        return reconnectExpired(event.now);
      }
      if (state.candidateAttemptId !== undefined) {
        throw new SessionTransitionError(
          "RESUME_IN_PROGRESS",
          "another resume candidate already exists",
        );
      }
      return { ...state, candidateAttemptId: event.attemptId };
    case "RESUME_FAILED":
      if (state.candidateAttemptId !== event.attemptId) {
        throw new SessionTransitionError(
          "STALE_RESUME_ATTEMPT",
          "resume failure does not match current candidate",
        );
      }
      return withoutCandidate(state);
    case "RESUME_COMMITTED":
      if (state.candidateAttemptId !== event.attemptId) {
        throw new SessionTransitionError(
          "STALE_RESUME_ATTEMPT",
          "resume commit does not match current candidate",
        );
      }
      if (!isResumeAllowed(event.now, state.disconnectedAt, policy)) {
        return reconnectExpired(event.now);
      }
      return {
        status: "ACTIVE",
        activatedAt: state.activatedAt,
        generation: state.generation + 1,
        activeStreamCount: 0,
        lastStreamClosedAt: state.lastStreamClosedAt,
      };
    case "TICK": {
      const maxDeadline = state.activatedAt + policy.maxTtlMs;
      if (event.now >= maxDeadline) {
        return { status: "EXPIRED", reason: "MAX_TTL", closedAt: event.now };
      }
      return isResumeAllowed(event.now, state.disconnectedAt, policy)
        ? state
        : reconnectExpired(event.now);
    }
    default:
      throw invalid(state, event);
  }
}

function expireActiveIfNeeded(
  state: Extract<SessionState, { status: "ACTIVE" }>,
  now: number,
  policy: SessionPolicy,
): SessionState {
  const maxDeadline = state.activatedAt + policy.maxTtlMs;
  if (now >= maxDeadline) {
    return { status: "EXPIRED", reason: "MAX_TTL", closedAt: now };
  }
  const deadline = getSessionDeadline({
    activatedAt: state.activatedAt,
    lastStreamClosedAt: state.lastStreamClosedAt,
    activeStreamCount: state.activeStreamCount,
    policy,
  });
  return now >= deadline
    ? { status: "EXPIRED", reason: "IDLE_TIMEOUT", closedAt: now }
    : state;
}

function reconnectExpired(now: number): SessionState {
  return { status: "EXPIRED", reason: "RECONNECT_TIMEOUT", closedAt: now };
}

function withoutCandidate(
  state: Extract<SessionState, { status: "RECONNECTING" }>,
): SessionState {
  const {
    candidateAttemptId: _candidateAttemptId,
    ...remaining
  } = state;
  return remaining;
}

function invalid(state: SessionState, event: SessionEvent): SessionTransitionError {
  return new SessionTransitionError(
    "INVALID_TRANSITION",
    `${event.type} is invalid from ${state.status}`,
  );
}
