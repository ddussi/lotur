import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  Account,
  AccountRole,
  AuditEvent,
  AuthRepository,
  AuthSession,
  LoginThrottle,
  LoginIntent,
  SessionExchange,
  CarrierCredential,
  CarrierPurpose,
} from "../../auth/src/index.ts";
import { AUTH_SCHEMA_SQL } from "./schema.ts";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export class PostgresAuthRepository implements AuthRepository {
  readonly #database: Pool;

  constructor(database: Pool) {
    this.#database = database;
  }

  async checkHealth(): Promise<void> {
    await this.#database.query("SELECT 1");
  }

  async migrate(): Promise<void> {
    const client = await this.#database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_112]);
      await client.query(AUTH_SCHEMA_SQL);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async countAccounts(): Promise<number> {
    const result = await this.#database.query<{ count: string }>("SELECT count(*)::text AS count FROM rt_accounts");
    return Number(result.rows[0]?.count ?? 0);
  }

  async createFirstAccount(account: Account): Promise<boolean> {
    const client = await this.#database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_113]);
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM rt_accounts");
      if (Number(count.rows[0]?.count ?? 0) !== 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await saveAccount(client, account);
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

  async saveAccount(account: Account): Promise<void> {
    await saveAccount(this.#database, account);
  }

  async saveSession(session: AuthSession): Promise<void> {
    await this.#database.query(
      `INSERT INTO rt_auth_sessions
       (id, token_digest, account_id, account_auth_version, audience, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         token_digest = EXCLUDED.token_digest,
         account_id = EXCLUDED.account_id,
         account_auth_version = EXCLUDED.account_auth_version,
         audience = EXCLUDED.audience,
         expires_at = EXCLUDED.expires_at,
         last_seen_at = EXCLUDED.last_seen_at`,
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
  }

  async findSessionByTokenDigest(tokenDigest: string): Promise<AuthSession | undefined> {
    const result = await this.#database.query<AuthSessionRow>(
      "SELECT * FROM rt_auth_sessions WHERE token_digest = $1",
      [tokenDigest],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      id: row.id,
      tokenDigest: row.token_digest,
      accountId: row.account_id,
      accountAuthVersion: row.account_auth_version,
      audience: row.audience,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
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

  async saveLoginThrottle(throttle: LoginThrottle): Promise<void> {
    await this.#database.query(
      `INSERT INTO rt_login_throttles(key, failures, locked_until, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET failures = EXCLUDED.failures,
         locked_until = EXCLUDED.locked_until, updated_at = EXCLUDED.updated_at`,
      [throttle.key, throttle.failures, throttle.lockedUntil ?? null, throttle.updatedAt],
    );
  }

  async deleteLoginThrottle(key: string): Promise<void> {
    await this.#database.query("DELETE FROM rt_login_throttles WHERE key = $1", [key]);
  }

  async saveLoginIntent(intent: LoginIntent): Promise<void> {
    await this.#database.query(
      `INSERT INTO rt_login_intents(id, target_host, target_path, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [intent.id, intent.targetHost, intent.targetPath, intent.expiresAt],
    );
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

  async saveSessionExchange(exchange: SessionExchange): Promise<void> {
    await this.#database.query(
      `INSERT INTO rt_session_exchanges(code_digest, account_id, target_host, target_path, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        exchange.codeDigest,
        exchange.accountId,
        exchange.targetHost,
        exchange.targetPath,
        exchange.expiresAt,
      ],
    );
  }

  async consumeSessionExchange(
    codeDigest: string,
    targetHost: string,
    now: Date,
  ): Promise<SessionExchange | undefined> {
    const result = await this.#database.query<SessionExchangeRow>(
      `DELETE FROM rt_session_exchanges
       WHERE code_digest = $1 AND target_host = $2 AND expires_at > $3
       RETURNING code_digest, account_id, target_host, target_path, expires_at`,
      [codeDigest, targetHost, now],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      codeDigest: row.code_digest,
      accountId: row.account_id,
      targetHost: row.target_host,
      targetPath: row.target_path,
      expiresAt: row.expires_at,
    };
  }

  async saveCarrierCredential(credential: CarrierCredential): Promise<void> {
    await this.#database.query(
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

  async deleteExpiredAuthArtifacts(now: Date): Promise<void> {
    await this.#database.query("DELETE FROM rt_auth_sessions WHERE expires_at <= $1", [now]);
    await this.#database.query("DELETE FROM rt_login_intents WHERE expires_at <= $1", [now]);
    await this.#database.query("DELETE FROM rt_session_exchanges WHERE expires_at <= $1", [now]);
    await this.#database.query("DELETE FROM rt_carrier_credentials WHERE expires_at <= $1", [now]);
    await this.#database.query(
      "DELETE FROM rt_login_throttles WHERE updated_at <= $1::timestamptz - interval '24 hours'",
      [now],
    );
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    await this.#database.query(
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

type AuthSessionRow = QueryResultRow & {
  id: string;
  token_digest: string;
  account_id: string;
  account_auth_version: number;
  audience: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
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

async function saveAccount(database: Queryable, account: Account): Promise<void> {
  await database.query(
    `INSERT INTO rt_accounts
     (id, username, display_name, roles, password_hash, enabled, must_change_password,
      auth_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       display_name = EXCLUDED.display_name,
       roles = EXCLUDED.roles,
       password_hash = EXCLUDED.password_hash,
       enabled = EXCLUDED.enabled,
       must_change_password = EXCLUDED.must_change_password,
       auth_version = EXCLUDED.auth_version,
       updated_at = EXCLUDED.updated_at`,
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
