import {
  AuditEventCapacityError,
  type AuditEventLimits,
  validateAuditEventLimits,
} from "../../auth/src/index.ts";
import { AUDIT_EVENT_CAPACITY_LOCK_ID } from "./capacity-locks.ts";
import type { Queryable } from "./postgres-transaction.ts";

export type StoredAuditEvent = Readonly<{
  id: string;
  action: string;
  actorAccountId?: string;
  targetAccountId?: string;
  occurredAt: Date;
  metadata: Readonly<Record<string, string | number | boolean>>;
}>;

export function validatedAuditEventLimits(limits: AuditEventLimits): AuditEventLimits {
  return validateAuditEventLimits(limits);
}

export async function appendBoundedAuditEvent(
  database: Queryable,
  event: StoredAuditEvent,
  limits: AuditEventLimits,
  scope: "ADMINISTRATIVE" | "OPERATIONAL",
): Promise<void> {
  const maximum = scope === "OPERATIONAL"
    ? limits.global
    : limits.global - limits.operationalReserve;
  await database.query("SELECT pg_advisory_xact_lock($1)", [
    AUDIT_EVENT_CAPACITY_LOCK_ID,
  ]);
  const reserved = await database.query(
    `UPDATE rt_audit_event_capacity
     SET event_count = event_count + 1
     WHERE singleton = true AND event_count < $1
     RETURNING event_count`,
    [maximum],
  );
  if (reserved.rowCount !== 1) throw new AuditEventCapacityError();
  await database.query(
    `INSERT INTO rt_audit_events
     (id, action, actor_account_id, target_account_id, occurred_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.id,
      event.action,
      event.actorAccountId ?? null,
      event.targetAccountId ?? null,
      event.occurredAt,
      JSON.stringify(event.metadata),
    ],
  );
}
