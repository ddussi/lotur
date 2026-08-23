export type AuditEventLimits = Readonly<{
  global: number;
  operationalReserve: number;
}>;

export const DEFAULT_AUDIT_EVENT_LIMITS: AuditEventLimits = Object.freeze({
  global: 1_000_000,
  operationalReserve: 1_000,
});

export class AuditEventCapacityError extends Error {
  constructor(message = "durable audit event capacity is exhausted") {
    super(message);
    this.name = "AuditEventCapacityError";
  }
}

export function validateAuditEventLimits(limits: AuditEventLimits): AuditEventLimits {
  if (
    !Number.isSafeInteger(limits.global) ||
    limits.global < 2 ||
    !Number.isSafeInteger(limits.operationalReserve) ||
    limits.operationalReserve < 1 ||
    limits.operationalReserve >= limits.global
  ) {
    throw new TypeError(
      "audit event limits must be safe integers with global >= 2 and 1 <= operationalReserve < global",
    );
  }
  return {
    global: limits.global,
    operationalReserve: limits.operationalReserve,
  };
}
