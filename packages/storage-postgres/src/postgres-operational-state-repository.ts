import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  DEFAULT_AUDIT_EVENT_LIMITS,
  type AuditEventLimits,
} from "../../auth/src/index.ts";
import {
  OperationalStateError,
  type CanaryStatus,
  type DeploymentIdentity,
  type OperationalState,
  type OperationalActor,
  type OperationalStateRepository,
} from "../../operations/src/index.ts";
import {
  appendBoundedAuditEvent,
  validatedAuditEventLimits,
} from "./bounded-audit-writer.ts";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

async function requireOperationalActor(
  database: Queryable,
  actor: OperationalActor,
): Promise<void> {
  const result = await database.query(
    `SELECT id FROM rt_accounts
     WHERE id = $1
       AND auth_version = $2
       AND enabled = true
       AND must_change_password = false
       AND 'ADMIN' = ANY(roles)
     FOR UPDATE`,
    [actor.accountId, actor.accountAuthVersion],
  );
  if (result.rowCount !== 1) {
    throw new OperationalStateError(
      "ACTOR_NOT_AUTHORIZED",
      "current administrator authorization is required",
    );
  }
}

export class PostgresOperationalStateRepository implements OperationalStateRepository {
  readonly #database: Pool;
  readonly #auditEventLimits: AuditEventLimits;

  constructor(
    database: Pool,
    options: Readonly<{ auditEventLimits?: AuditEventLimits }> = {},
  ) {
    this.#database = database;
    this.#auditEventLimits = validatedAuditEventLimits(
      options.auditEventLimits ?? DEFAULT_AUDIT_EVENT_LIMITS,
    );
  }

  async getOperationalState(identity: DeploymentIdentity): Promise<OperationalState> {
    return readOperationalState(this.#database, identity);
  }

  async recordCanaryResult(
    identity: DeploymentIdentity,
    result: Exclude<CanaryStatus, "UNKNOWN">,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState> {
    return this.#transaction(async (client) => {
      await requireOperationalActor(client, actor);
      await client.query(
        `INSERT INTO rt_deployment_admissions
         (deployment_id, config_digest, canary_status, canary_checked_at,
          admission_approved_at, admission_approved_by, updated_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, $4)
         ON CONFLICT (deployment_id, config_digest) DO UPDATE SET
           canary_status = EXCLUDED.canary_status,
           canary_checked_at = EXCLUDED.canary_checked_at,
           admission_approved_at = CASE
             WHEN rt_deployment_admissions.canary_status = 'PASSED'
               AND EXCLUDED.canary_status = 'PASSED'
             THEN rt_deployment_admissions.admission_approved_at
             ELSE NULL
           END,
           admission_approved_by = CASE
             WHEN rt_deployment_admissions.canary_status = 'PASSED'
               AND EXCLUDED.canary_status = 'PASSED'
             THEN rt_deployment_admissions.admission_approved_by
             ELSE NULL
           END,
           updated_at = EXCLUDED.updated_at`,
        [identity.deploymentId, identity.configDigest, result, now],
      );
      await this.#appendOperationalAudit(client, {
        action: result === "PASSED" ? "CANARY_PASSED" : "CANARY_FAILED",
        actorAccountId: actor.accountId,
        identity,
        now,
      });
      return readOperationalState(client, identity);
    });
  }

  async approveAdmission(
    identity: DeploymentIdentity,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState> {
    return this.#transaction(async (client) => {
      await requireOperationalActor(client, actor);
      const result = await client.query(
        `UPDATE rt_deployment_admissions
         SET admission_approved_at = $3, admission_approved_by = $4, updated_at = $3
         WHERE deployment_id = $1 AND config_digest = $2 AND canary_status = 'PASSED'
         RETURNING deployment_id`,
        [identity.deploymentId, identity.configDigest, now, actor.accountId],
      );
      if (result.rowCount !== 1) {
        throw new OperationalStateError(
          "CANARY_REQUIRED",
          "matching successful canary is required before admission approval",
        );
      }
      await this.#appendOperationalAudit(client, {
        action: "ADMISSION_APPROVED",
        actorAccountId: actor.accountId,
        identity,
        now,
      });
      return readOperationalState(client, identity);
    });
  }

  async closeAdmission(
    identity: DeploymentIdentity,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState> {
    return this.#transaction(async (client) => {
      await requireOperationalActor(client, actor);
      await client.query(
        `INSERT INTO rt_deployment_admissions
         (deployment_id, config_digest, canary_status, admission_approved_at,
          admission_approved_by, updated_at)
         VALUES ($1, $2, 'UNKNOWN', NULL, NULL, $3)
         ON CONFLICT (deployment_id, config_digest) DO UPDATE SET
           canary_status = 'UNKNOWN',
           canary_checked_at = NULL,
           admission_approved_at = NULL,
           admission_approved_by = NULL,
           updated_at = EXCLUDED.updated_at`,
        [identity.deploymentId, identity.configDigest, now],
      );
      await this.#appendOperationalAudit(client, {
        action: "ADMISSION_CLOSED",
        actorAccountId: actor.accountId,
        identity,
        now,
      });
      return readOperationalState(client, identity);
    });
  }

  async setKillSwitch(
    identity: DeploymentIdentity,
    enabled: boolean,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState> {
    return this.#transaction(async (client) => {
      await requireOperationalActor(client, actor);
      await client.query(
        `UPDATE rt_operational_controls
         SET kill_switch_enabled = $1, updated_at = $2
         WHERE singleton = true`,
        [enabled, now],
      );
      if (enabled) {
        await client.query(
          `UPDATE rt_deployment_admissions
           SET canary_status = 'UNKNOWN',
               canary_checked_at = NULL,
               admission_approved_at = NULL,
               admission_approved_by = NULL,
               updated_at = $1`,
          [now],
        );
      }
      await this.#appendOperationalAudit(client, {
        action: enabled ? "KILL_SWITCH_ENABLED" : "KILL_SWITCH_DISABLED",
        actorAccountId: actor.accountId,
        identity,
        now,
      });
      return readOperationalState(client, identity);
    });
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #appendOperationalAudit(
    database: Queryable,
    event: Readonly<{
      action: string;
      actorAccountId: string;
      identity: DeploymentIdentity;
      now: Date;
    }>,
  ): Promise<void> {
    await appendBoundedAuditEvent(database, {
      id: randomUUID(),
      action: event.action,
      actorAccountId: event.actorAccountId,
      occurredAt: event.now,
      metadata: event.identity,
    }, this.#auditEventLimits, "OPERATIONAL");
  }
}

type OperationalRow = QueryResultRow & {
  kill_switch_enabled: boolean;
  controls_updated_at: Date;
  canary_status: CanaryStatus | null;
  canary_checked_at: Date | null;
  admission_approved_at: Date | null;
  admission_approved_by: string | null;
  deployment_updated_at: Date | null;
};

async function readOperationalState(
  database: Queryable,
  identity: DeploymentIdentity,
): Promise<OperationalState> {
  const result = await database.query<OperationalRow>(
    `SELECT controls.kill_switch_enabled,
            controls.updated_at AS controls_updated_at,
            deployment.canary_status,
            deployment.canary_checked_at,
            deployment.admission_approved_at,
            deployment.admission_approved_by,
            deployment.updated_at AS deployment_updated_at
     FROM rt_operational_controls AS controls
     LEFT JOIN rt_deployment_admissions AS deployment
       ON deployment.deployment_id = $1 AND deployment.config_digest = $2
     WHERE controls.singleton = true`,
    [identity.deploymentId, identity.configDigest],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("operational controls are not initialized");
  return {
    identity,
    killSwitchEnabled: row.kill_switch_enabled,
    canaryStatus: row.canary_status ?? "UNKNOWN",
    updatedAt: row.deployment_updated_at ?? row.controls_updated_at,
    ...(row.canary_checked_at === null ? {} : { canaryCheckedAt: row.canary_checked_at }),
    ...(row.admission_approved_at === null
      ? {}
      : { admissionApprovedAt: row.admission_approved_at }),
    ...(row.admission_approved_by === null
      ? {}
      : { admissionApprovedBy: row.admission_approved_by }),
  };
}
