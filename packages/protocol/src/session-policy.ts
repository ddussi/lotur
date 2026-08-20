export type SessionPolicy = Readonly<{
  maxTtlMs: number;
  idleTimeoutMs: number;
  reconnectGraceMs: number;
}>;

const minute = 60_000;
const hour = 60 * minute;

export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({
  maxTtlMs: 8 * hour,
  idleTimeoutMs: 30 * minute,
  reconnectGraceMs: 2 * minute,
});

export function getSessionDeadline(input: Readonly<{
  activatedAt: number;
  lastStreamClosedAt: number;
  activeStreamCount: number;
  policy: SessionPolicy;
}>): number {
  if (input.activeStreamCount < 0 || !Number.isInteger(input.activeStreamCount)) {
    throw new RangeError("activeStreamCount must be a non-negative integer");
  }

  const maxDeadline = input.activatedAt + input.policy.maxTtlMs;
  if (input.activeStreamCount > 0) {
    return maxDeadline;
  }

  return Math.min(
    maxDeadline,
    input.lastStreamClosedAt + input.policy.idleTimeoutMs,
  );
}

export function isResumeAllowed(
  now: number,
  disconnectedAt: number,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): boolean {
  return now >= disconnectedAt && now <= disconnectedAt + policy.reconnectGraceMs;
}

