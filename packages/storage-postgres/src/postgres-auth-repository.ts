import type { Pool, QueryResultRow } from "pg";

import type {
  Account,
  AccountRole,
  AuditEvent,
  AuditEventLimits,
  AuthRepository,
  AuthSession,
  LoginThrottle,
  LoginIntent,
  SessionExchange,
  CarrierCredential,
  CarrierPurpose,
  LoginIntentLimits,
  AccountMutationAuthorization,
  StoredArtifactLimits,
} from "../../auth/src/index.ts";
import { DEFAULT_AUDIT_EVENT_LIMITS } from "../../auth/src/index.ts";
import {
  appendBoundedAuditEvent,
  validatedAuditEventLimits,
} from "./bounded-audit-writer.ts";
import {
  AUDIT_EVENT_CAPACITY_LOCK_ID,
  LOGIN_THROTTLE_CAPACITY_LOCK_ID,
} from "./capacity-locks.ts";
import { AUTH_SCHEMA_SQL } from "./schema.ts";
import { type Queryable, withTransaction } from "./postgres-transaction.ts";

export class PostgresAuthRepository implements AuthRepository {
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

  async checkHealth(): Promise<void> {
    await this.#database.query("SELECT 1");
  }

  async migrate(): Promise<void> {
    await withTransaction(this.#database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_112]);
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        LOGIN_THROTTLE_CAPACITY_LOCK_ID,
      ]);
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        AUDIT_EVENT_CAPACITY_LOCK_ID,
      ]);
      await client.query(AUTH_SCHEMA_SQL);
    });
  }

  async countAccounts(): Promise<number> {
    const result = await this.#database.query<{ count: string }>("SELECT count(*)::text AS count FROM rt_accounts");
    return Number(result.rows[0]?.count ?? 0);
  }

  async createFirstAccount(account: Account, auditEvent: AuditEvent): Promise<boolean> {
    const client = await this.#database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_113]);
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM rt_accounts");
      if (Number(count.rows[0]?.count ?? 0) !== 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await insertAccount(client, account);
      await this.#appendAuditEvent(client, auditEvent);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async countEnabledAdministrators(): Promise<number> {
    const result = await this.#database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rt_accounts WHERE enabled = true AND 'ADMIN' = ANY(roles)",
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async findAccountById(id: string): Promise<Account | undefined> {
    const result = await this.#database.query<AccountRow>(
      "SELECT * FROM rt_accounts WHERE id = $1",
      [id],
    );
    return optionalAccount(result.rows[0]);
  }

  async findAccountsByIds(ids: readonly string[]): Promise<readonly Account[]> {
    const result = await this.#database.query<AccountRow>(
      "SELECT * FROM rt_accounts WHERE id = ANY($1::text[])",
      [ids],
    );
    return result.rows.map(toAccount);
  }

  async findAccountByUsername(username: string): Promise<Account | undefined> {
    const result = await this.#database.query<AccountRow>(
      "SELECT * FROM rt_accounts WHERE username = $1",
      [username],
    );
    return optionalAccount(result.rows[0]);
  }

  async listAccounts(): Promise<readonly Account[]> {
    const result = await this.#database.query<AccountRow>("SELECT * FROM rt_accounts ORDER BY username");
    return result.rows.map(toAccount);
  }

  async createAccount(input: Readonly<{
    account: Account;
    authorization: AccountMutationAuthorization;
    auditEvent: AuditEvent;
  }>) {
    return withTransaction(this.#database, async (client) => {
      await lockAccountMutations(client);
      if (!await authorizeActorForMutation(client, input.authorization)) {
        return { status: "ACTOR_NOT_AUTHORIZED" } as const;
      }
      try {
        await insertAccount(client, input.account);
      } catch (error) {
        if (isUniqueConstraintViolation(error, "rt_accounts_username_key")) {
          return { status: "ALREADY_EXISTS" } as const;
        }
        throw error;
      }
      await this.#appendAuditEvent(client, input.auditEvent);
      return { status: "CREATED" } as const;
    });
  }

  async setAccountEnabled(input: Readonly<{
    accountId: string;
    enabled: boolean;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>) {
    return withTransaction(this.#database, async (client) => {
      await lockAccountMutations(client);
      if (!await authorizeActorForMutation(client, input.authorization)) {
        return { status: "ACTOR_NOT_AUTHORIZED" } as const;
      }
      const account = await findAccountForUpdate(client, input.accountId);
      if (account === undefined) return { status: "NOT_FOUND" } as const;
      if (
        !input.enabled &&
        account.enabled &&
        account.roles.includes("ADMIN") &&
        await countEnabledAdministrators(client) <= 1
      ) return { status: "LAST_ADMINISTRATOR" } as const;
      const result = await client.query<AccountRow>(
        `UPDATE rt_accounts
         SET enabled = $2, auth_version = auth_version + 1, updated_at = $3
         WHERE id = $1
         RETURNING *`,
        [input.accountId, input.enabled, input.updatedAt],
      );
      const updated = toAccount(result.rows[0]!);
      await deleteAccountAuthArtifacts(client, input.accountId);
      await this.#appendAuditEvent(client, input.auditEvent);
      return { status: "UPDATED", account: updated } as const;
    });
  }

  async setAccountRoles(input: Readonly<{
    accountId: string;
    roles: readonly AccountRole[];
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>) {
    return withTransaction(this.#database, async (client) => {
      await lockAccountMutations(client);
      if (!await authorizeActorForMutation(client, input.authorization)) {
        return { status: "ACTOR_NOT_AUTHORIZED" } as const;
      }
      const account = await findAccountForUpdate(client, input.accountId);
      if (account === undefined) return { status: "NOT_FOUND" } as const;
      if (
        account.enabled &&
        account.roles.includes("ADMIN") &&
        !input.roles.includes("ADMIN") &&
        await countEnabledAdministrators(client) <= 1
      ) return { status: "LAST_ADMINISTRATOR" } as const;
      const result = await client.query<AccountRow>(
        `UPDATE rt_accounts
         SET roles = $2, auth_version = auth_version + 1, updated_at = $3
         WHERE id = $1
         RETURNING *`,
        [input.accountId, input.roles, input.updatedAt],
      );
      const updated = toAccount(result.rows[0]!);
      await deleteAccountAuthArtifacts(client, input.accountId);
      await this.#appendAuditEvent(client, input.auditEvent);
      return { status: "UPDATED", account: updated } as const;
    });
  }

  async replaceAccountPassword(input: Readonly<{
    accountId: string;
    passwordHash: string;
    mustChangePassword: boolean;
    expectedAuthVersion: number;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>) {
    return withTransaction(this.#database, async (client) => {
      await lockAccountMutations(client);
      if (!await authorizeActorForMutation(client, input.authorization)) {
        return { status: "ACTOR_NOT_AUTHORIZED" } as const;
      }
      const account = await findAccountForUpdate(client, input.accountId);
      if (account === undefined) return { status: "NOT_FOUND" } as const;
      if (
        account.authVersion !== input.expectedAuthVersion
      ) return { status: "CONFLICT" } as const;
      const result = await client.query<AccountRow>(
        `UPDATE rt_accounts
         SET password_hash = $2, must_change_password = $3,
             auth_version = auth_version + 1, updated_at = $4
         WHERE id = $1
         RETURNING *`,
        [input.accountId, input.passwordHash, input.mustChangePassword, input.updatedAt],
      );
      const updated = toAccount(result.rows[0]!);
      await deleteAccountAuthArtifacts(client, input.accountId);
      await this.#appendAuditEvent(client, input.auditEvent);
      return { status: "UPDATED", account: updated } as const;
    });
  }

  async revokeAccountSessions(input: Readonly<{
    accountId: string;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>) {
    return withTransaction(this.#database, async (client) => {
      await lockAccountMutations(client);
      if (!await authorizeActorForMutation(client, input.authorization)) {
        return { status: "ACTOR_NOT_AUTHORIZED" } as const;
      }
      const result = await client.query<AccountRow>(
        `UPDATE rt_accounts
         SET auth_version = auth_version + 1, updated_at = $2
         WHERE id = $1
         RETURNING *`,
        [input.accountId, input.updatedAt],
      );
      const row = result.rows[0];
      if (row === undefined) return { status: "NOT_FOUND" } as const;
      await deleteAccountAuthArtifacts(client, input.accountId);
      await this.#appendAuditEvent(client, input.auditEvent);
      return { status: "UPDATED", account: toAccount(row) } as const;
    });
  }

  async saveSession(
    session: AuthSession,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean> {
    return withTransaction(this.#database, async (client) => {
      if (!await lockCurrentArtifactAccount(
        client,
        session.accountId,
        session.accountAuthVersion,
      )) return false;
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_116]);
      await deleteExpiredArtifactBatch(client, "rt_auth_sessions", now);
      if (!await hasArtifactCapacity(
        client,
        "rt_auth_sessions",
        session.accountId,
        limits,
        now,
      )) return false;
      await client.query(
        `INSERT INTO rt_auth_sessions
         (id, token_digest, account_id, account_auth_version, audience, created_at, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          session.id,
          session.tokenDigest,
          session.accountId,
          session.accountAuthVersion,
          session.audience,
          session.createdAt,
          session.expiresAt,
          session.lastSeenAt,
        ],
      );
      return true;
    });
  }

  async findSessionAccountByTokenDigests(tokenDigests: readonly string[]) {
    const result = await this.#database.query<SessionAccountRow>(
      `SELECT session.id AS session_id,
              session.token_digest AS session_token_digest,
              session.account_id AS session_account_id,
              session.account_auth_version AS session_account_auth_version,
              session.audience AS session_audience,
              session.created_at AS session_created_at,
              session.expires_at AS session_expires_at,
              session.last_seen_at AS session_last_seen_at,
              account.id AS account_id,
              account.username AS account_username,
              account.display_name AS account_display_name,
              account.roles AS account_roles,
              account.password_hash AS account_password_hash,
              account.enabled AS account_enabled,
              account.must_change_password AS account_must_change_password,
              account.auth_version AS account_auth_version,
              account.created_at AS account_created_at,
              account.updated_at AS account_updated_at
       FROM unnest($1::text[]) WITH ORDINALITY AS candidate(token_digest, priority)
       JOIN rt_auth_sessions AS session
         ON session.token_digest = candidate.token_digest
       JOIN rt_accounts AS account ON account.id = session.account_id
       ORDER BY candidate.priority
       LIMIT 1`,
      [tokenDigests],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      session: {
        id: row.session_id,
        tokenDigest: row.session_token_digest,
        accountId: row.session_account_id,
        accountAuthVersion: row.session_account_auth_version,
        audience: row.session_audience,
        createdAt: row.session_created_at,
        expiresAt: row.session_expires_at,
        lastSeenAt: row.session_last_seen_at,
      },
      account: {
        id: row.account_id,
        username: row.account_username,
        displayName: row.account_display_name,
        roles: row.account_roles as AccountRole[],
        passwordHash: row.account_password_hash,
        enabled: row.account_enabled,
        mustChangePassword: row.account_must_change_password,
        authVersion: row.account_auth_version,
        createdAt: row.account_created_at,
        updatedAt: row.account_updated_at,
      },
    };
  }

  async deleteSession(id: string): Promise<void> {
    await this.#database.query("DELETE FROM rt_auth_sessions WHERE id = $1", [id]);
  }

  async deleteSessionsForAccount(accountId: string): Promise<void> {
    await this.#database.query("DELETE FROM rt_auth_sessions WHERE account_id = $1", [accountId]);
  }

  async getLoginThrottle(key: string): Promise<LoginThrottle | undefined> {
    const result = await this.#database.query<LoginThrottleRow>(
      "SELECT key, failures, locked_until, updated_at FROM rt_login_throttles WHERE key = $1",
      [key],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      key: row.key,
      failures: row.failures,
      updatedAt: row.updated_at,
      ...(row.locked_until === null ? {} : { lockedUntil: row.locked_until }),
    };
  }

  async recordLoginFailure(input: Readonly<{
    keys: readonly string[];
    now: Date;
    windowStartsAt: Date;
    lockThreshold: number;
    lockedUntil: Date;
    limits: Readonly<{ global: number }>;
  }>) {
    if (!Number.isSafeInteger(input.limits.global) || input.limits.global < 1) {
      throw new TypeError("login throttle global limit must be a positive safe integer");
    }
    return withTransaction(this.#database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        LOGIN_THROTTLE_CAPACITY_LOCK_ID,
      ]);
      const keys = [...new Set(input.keys)].sort();
      const existingResult = await client.query<{ key: string }>(
        "SELECT key FROM rt_login_throttles WHERE key = ANY($1::text[])",
        [keys],
      );
      const existingKeys = new Set(existingResult.rows.map((row) => row.key));
      const countResult = await client.query<{ entry_count: string }>(
        `SELECT entry_count::text AS entry_count
         FROM rt_login_throttle_capacity WHERE singleton = true FOR UPDATE`,
      );
      const newKeys = keys.filter((key) => !existingKeys.has(key));
      let storedCount = Number(countResult.rows[0]?.entry_count ?? Number.NaN);
      if (!Number.isSafeInteger(storedCount) || storedCount < 0) {
        throw new Error("login throttle capacity counter is not initialized");
      }
      const initiallyAvailable = Math.max(0, input.limits.global - storedCount);
      const staleRowsNeeded = Math.max(0, newKeys.length - initiallyAvailable);
      if (staleRowsNeeded > 0) {
        const reclaimed = await client.query(
          `DELETE FROM rt_login_throttles
           WHERE ctid IN (
             SELECT ctid FROM rt_login_throttles
             WHERE updated_at <= $1 AND NOT (key = ANY($2::text[]))
             ORDER BY updated_at, ctid
             LIMIT $3
           )`,
          [input.windowStartsAt, keys, staleRowsNeeded],
        );
        const reclaimedCount = reclaimed.rowCount ?? 0;
        if (reclaimedCount > 0) {
          await decrementLoginThrottleCount(client, reclaimedCount);
          storedCount -= reclaimedCount;
        }
      }
      const availableNewKeys = Math.max(0, input.limits.global - storedCount);
      const admittedNewKeys = newKeys.slice(0, availableNewKeys);
      const admittedKeys = new Set([
        ...existingKeys,
        ...admittedNewKeys,
      ]);
      if (admittedNewKeys.length > 0) {
        const reserved = await client.query(
          `UPDATE rt_login_throttle_capacity
           SET entry_count = entry_count + $1
           WHERE singleton = true AND entry_count + $1 <= $2
           RETURNING entry_count`,
          [admittedNewKeys.length, input.limits.global],
        );
        if (reserved.rowCount !== 1) {
          throw new Error("login throttle capacity reservation failed");
        }
      }
      const throttles: LoginThrottle[] = [];
      for (const key of keys) {
        if (!admittedKeys.has(key)) continue;
        const result = await client.query<LoginThrottleRow>(
          `INSERT INTO rt_login_throttles(key, failures, locked_until, updated_at)
           VALUES ($1, 1, CASE WHEN $4 <= 1 THEN $5::timestamptz ELSE NULL END, $3)
           ON CONFLICT (key) DO UPDATE SET
             failures = CASE
               WHEN rt_login_throttles.updated_at > $2 THEN rt_login_throttles.failures + 1
               ELSE 1
             END,
             locked_until = CASE
               WHEN (CASE
                 WHEN rt_login_throttles.updated_at > $2 THEN rt_login_throttles.failures + 1
                 ELSE 1
               END) >= $4 THEN $5::timestamptz
               ELSE NULL
             END,
             updated_at = $3
           RETURNING key, failures, locked_until, updated_at`,
          [key, input.windowStartsAt, input.now, input.lockThreshold, input.lockedUntil],
        );
        throttles.push(toLoginThrottle(result.rows[0]!));
      }
      return {
        status: admittedKeys.size === keys.length ? "RECORDED" : "CAPACITY_EXHAUSTED",
        throttles,
      } as const;
    });
  }

  async deleteLoginThrottles(keys: readonly string[]): Promise<void> {
    await withTransaction(this.#database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        LOGIN_THROTTLE_CAPACITY_LOCK_ID,
      ]);
      const deleted = await client.query(
        "DELETE FROM rt_login_throttles WHERE key = ANY($1::text[])",
        [[...new Set(keys)]],
      );
      const deletedCount = deleted.rowCount ?? 0;
      if (deletedCount > 0) {
        await decrementLoginThrottleCount(client, deletedCount);
      }
    });
  }

  async saveLoginIntent(
    intent: LoginIntent,
    now: Date,
    limits: LoginIntentLimits,
  ): Promise<boolean> {
    return withTransaction(this.#database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_115]);
      await client.query(
        `DELETE FROM rt_login_intents
         WHERE ctid IN (
           SELECT ctid FROM rt_login_intents WHERE expires_at <= $1 ORDER BY expires_at LIMIT 500
         )`,
        [now],
      );
      const counts = await client.query<{ total: number; host: number }>(
        `SELECT count(*)::integer AS total,
                count(*) FILTER (WHERE target_host = $1)::integer AS host
         FROM rt_login_intents`,
        [intent.targetHost],
      );
      const count = counts.rows[0] ?? { total: 0, host: 0 };
      if (count.total >= limits.global || count.host >= limits.perHost) return false;
      await client.query(
        `INSERT INTO rt_login_intents(id, target_host, target_path, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [intent.id, intent.targetHost, intent.targetPath, intent.expiresAt],
      );
      return true;
    });
  }

  async consumeLoginIntent(id: string, now: Date): Promise<LoginIntent | undefined> {
    const result = await this.#database.query<LoginIntentRow>(
      `DELETE FROM rt_login_intents
       WHERE id = $1 AND expires_at > $2
       RETURNING id, target_host, target_path, expires_at`,
      [id, now],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      id: row.id,
      targetHost: row.target_host,
      targetPath: row.target_path,
      expiresAt: row.expires_at,
    };
  }

  async saveSessionExchange(
    exchange: SessionExchange,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean> {
    return withTransaction(this.#database, async (client) => {
      if (!await lockCurrentArtifactAccount(
        client,
        exchange.accountId,
        exchange.accountAuthVersion,
      )) return false;
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_117]);
      await deleteExpiredArtifactBatch(client, "rt_session_exchanges", now);
      if (!await hasArtifactCapacity(
        client,
        "rt_session_exchanges",
        exchange.accountId,
        limits,
        now,
      )) return false;
      await client.query(
        `INSERT INTO rt_session_exchanges
         (code_digest, account_id, account_auth_version, target_host, target_path, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          exchange.codeDigest,
          exchange.accountId,
          exchange.accountAuthVersion,
          exchange.targetHost,
          exchange.targetPath,
          exchange.expiresAt,
        ],
      );
      return true;
    });
  }

  async consumeSessionExchange(
    codeDigest: string,
    targetHost: string,
    now: Date,
  ): Promise<SessionExchange | undefined> {
    const result = await this.#database.query<SessionExchangeRow>(
      `DELETE FROM rt_session_exchanges
       WHERE code_digest = $1 AND target_host = $2 AND expires_at > $3
       RETURNING code_digest, account_id, account_auth_version, target_host, target_path, expires_at`,
      [codeDigest, targetHost, now],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      codeDigest: row.code_digest,
      accountId: row.account_id,
      accountAuthVersion: row.account_auth_version,
      targetHost: row.target_host,
      targetPath: row.target_path,
      expiresAt: row.expires_at,
    };
  }

  async saveCarrierCredential(
    credential: CarrierCredential,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean> {
    return withTransaction(this.#database, async (client) => {
      if (!await lockCurrentArtifactAccount(
        client,
        credential.accountId,
        credential.accountAuthVersion,
      )) return false;
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_118]);
      await deleteExpiredArtifactBatch(client, "rt_carrier_credentials", now);
      if (!await hasArtifactCapacity(
        client,
        "rt_carrier_credentials",
        credential.accountId,
        limits,
        now,
      )) return false;
      await client.query(
        `INSERT INTO rt_carrier_credentials
         (id, secret_digest, account_id, account_auth_version, purpose, tunnel_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          credential.id,
          credential.secretDigest,
          credential.accountId,
          credential.accountAuthVersion,
          credential.purpose,
          credential.tunnelId,
          credential.expiresAt,
        ],
      );
      return true;
    });
  }

  async consumeCarrierCredential(
    id: string,
    secretDigest: string,
    now: Date,
  ): Promise<CarrierCredential | undefined> {
    const result = await this.#database.query<CarrierCredentialRow>(
      `DELETE FROM rt_carrier_credentials
       WHERE id = $1 AND secret_digest = $2 AND expires_at > $3
       RETURNING id, secret_digest, account_id, account_auth_version, purpose, tunnel_id, expires_at`,
      [id, secretDigest, now],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      id: row.id,
      secretDigest: row.secret_digest,
      accountId: row.account_id,
      accountAuthVersion: row.account_auth_version,
      purpose: row.purpose,
      tunnelId: row.tunnel_id,
      expiresAt: row.expires_at,
    };
  }

  async deleteExpiredAuthArtifacts(now: Date, batchSize: number): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new TypeError("batchSize must be a positive safe integer");
    }
    return withTransaction(this.#database, async (client) => {
      let remaining = batchSize;
      let deleted = 0;
      const specifications = [
        ["rt_auth_sessions", "expires_at <= $1", "expires_at"],
        ["rt_login_intents", "expires_at <= $1", "expires_at"],
        ["rt_session_exchanges", "expires_at <= $1", "expires_at"],
        ["rt_carrier_credentials", "expires_at <= $1", "expires_at"],
      ] as const;
      for (const [table, predicate, orderColumn] of specifications) {
        if (remaining === 0) break;
        const result = await client.query(
          `DELETE FROM ${table}
           WHERE ctid IN (
             SELECT ctid FROM ${table}
             WHERE ${predicate}
             ORDER BY ${orderColumn}, ctid
             LIMIT $2
           )`,
          [now, remaining],
        );
        const rowCount = result.rowCount ?? 0;
        deleted += rowCount;
        remaining -= rowCount;
      }
      if (remaining > 0) {
        await client.query("SELECT pg_advisory_xact_lock($1)", [
          LOGIN_THROTTLE_CAPACITY_LOCK_ID,
        ]);
        const result = await client.query(
          `DELETE FROM rt_login_throttles
           WHERE ctid IN (
             SELECT ctid FROM rt_login_throttles
             WHERE updated_at <= $1::timestamptz - interval '15 minutes'
             ORDER BY updated_at, ctid
             LIMIT $2
           )`,
          [now, remaining],
        );
        const rowCount = result.rowCount ?? 0;
        if (rowCount > 0) await decrementLoginThrottleCount(client, rowCount);
        deleted += rowCount;
      }
      return deleted;
    });
  }

  async #appendAuditEvent(database: Queryable, event: AuditEvent): Promise<void> {
    await appendBoundedAuditEvent(
      database,
      event,
      this.#auditEventLimits,
      "ADMINISTRATIVE",
    );
  }
}

type AccountRow = QueryResultRow & {
  id: string;
  username: string;
  display_name: string;
  roles: string[];
  password_hash: string;
  enabled: boolean;
  must_change_password: boolean;
  auth_version: number;
  created_at: Date;
  updated_at: Date;
};

type SessionAccountRow = QueryResultRow & {
  session_id: string;
  session_token_digest: string;
  session_account_id: string;
  session_account_auth_version: number;
  session_audience: string;
  session_created_at: Date;
  session_expires_at: Date;
  session_last_seen_at: Date;
  account_id: string;
  account_username: string;
  account_display_name: string;
  account_roles: string[];
  account_password_hash: string;
  account_enabled: boolean;
  account_must_change_password: boolean;
  account_auth_version: number;
  account_created_at: Date;
  account_updated_at: Date;
};

type LoginThrottleRow = QueryResultRow & {
  key: string;
  failures: number;
  locked_until: Date | null;
  updated_at: Date;
};

type LoginIntentRow = QueryResultRow & {
  id: string;
  target_host: string;
  target_path: string;
  expires_at: Date;
};

type SessionExchangeRow = QueryResultRow & {
  code_digest: string;
  account_id: string;
  account_auth_version: number;
  target_host: string;
  target_path: string;
  expires_at: Date;
};

type CarrierCredentialRow = QueryResultRow & {
  id: string;
  secret_digest: string;
  account_id: string;
  account_auth_version: number;
  purpose: CarrierPurpose;
  tunnel_id: string;
  expires_at: Date;
};

async function decrementLoginThrottleCount(
  database: Queryable,
  amount: number,
): Promise<void> {
  const adjusted = await database.query(
    `UPDATE rt_login_throttle_capacity
     SET entry_count = entry_count - $1
     WHERE singleton = true AND entry_count >= $1
     RETURNING entry_count`,
    [amount],
  );
  if (adjusted.rowCount !== 1) {
    throw new Error("login throttle capacity counter is inconsistent");
  }
}

async function insertAccount(database: Queryable, account: Account): Promise<void> {
  await database.query(
    `INSERT INTO rt_accounts
     (id, username, display_name, roles, password_hash, enabled, must_change_password,
      auth_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      account.id,
      account.username,
      account.displayName,
      account.roles,
      account.passwordHash,
      account.enabled,
      account.mustChangePassword,
      account.authVersion,
      account.createdAt,
      account.updatedAt,
    ],
  );
}

async function findAccountForUpdate(
  database: Queryable,
  accountId: string,
): Promise<Account | undefined> {
  const result = await database.query<AccountRow>(
    "SELECT * FROM rt_accounts WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  return optionalAccount(result.rows[0]);
}

async function lockAccountMutations(database: Queryable): Promise<void> {
  await database.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_114]);
}

async function lockCurrentArtifactAccount(
  database: Queryable,
  accountId: string,
  accountAuthVersion: number,
): Promise<boolean> {
  const result = await database.query(
    `SELECT id FROM rt_accounts
     WHERE id = $1
       AND auth_version = $2
       AND enabled = true
     FOR SHARE`,
    [accountId, accountAuthVersion],
  );
  return result.rowCount === 1;
}

async function authorizeActorForMutation(
  database: Queryable,
  authorization: AccountMutationAuthorization,
): Promise<boolean> {
  const result = await database.query(
    `SELECT id FROM rt_accounts
     WHERE id = $1
       AND auth_version = $2
       AND enabled = true
       AND ($3::boolean = true OR must_change_password = false)
       AND ($4::text IS NULL OR $4::text = ANY(roles))
     FOR UPDATE`,
    [
      authorization.accountId,
      authorization.authVersion,
      authorization.allowPasswordChangeRequired === true,
      authorization.requiredRole ?? null,
    ],
  );
  return result.rowCount === 1;
}

async function countEnabledAdministrators(database: Queryable): Promise<number> {
  const result = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM rt_accounts WHERE enabled = true AND 'ADMIN' = ANY(roles)",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function hasArtifactCapacity(
  database: Queryable,
  table: "rt_auth_sessions" | "rt_session_exchanges" | "rt_carrier_credentials",
  accountId: string,
  limits: StoredArtifactLimits,
  now: Date,
): Promise<boolean> {
  const result = await database.query<{ total: string; account: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE account_id = $1)::text AS account
     FROM ${table}
     WHERE expires_at > $2`,
    [accountId, now],
  );
  const counts = result.rows[0] ?? { total: "0", account: "0" };
  return Number(counts.total) < limits.global &&
    Number(counts.account) < limits.perAccount;
}

async function deleteExpiredArtifactBatch(
  database: Queryable,
  table: "rt_auth_sessions" | "rt_session_exchanges" | "rt_carrier_credentials",
  now: Date,
): Promise<void> {
  await database.query(
    `DELETE FROM ${table}
     WHERE ctid IN (
       SELECT ctid FROM ${table}
       WHERE expires_at <= $1
       ORDER BY expires_at, ctid
       LIMIT 500
     )`,
    [now],
  );
}

async function deleteAccountAuthArtifacts(
  database: Queryable,
  accountId: string,
): Promise<void> {
  await database.query("DELETE FROM rt_auth_sessions WHERE account_id = $1", [accountId]);
  await database.query("DELETE FROM rt_session_exchanges WHERE account_id = $1", [accountId]);
  await database.query("DELETE FROM rt_carrier_credentials WHERE account_id = $1", [accountId]);
}

function isUniqueConstraintViolation(error: unknown, constraint: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint;
}

function toLoginThrottle(row: LoginThrottleRow): LoginThrottle {
  return {
    key: row.key,
    failures: row.failures,
    updatedAt: row.updated_at,
    ...(row.locked_until === null ? {} : { lockedUntil: row.locked_until }),
  };
}

function optionalAccount(row: AccountRow | undefined): Account | undefined {
  return row === undefined ? undefined : toAccount(row);
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roles: row.roles as AccountRole[],
    passwordHash: row.password_hash,
    enabled: row.enabled,
    mustChangePassword: row.must_change_password,
    authVersion: row.auth_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
