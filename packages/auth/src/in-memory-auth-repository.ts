import type {
  AccountMutationAuthorization,
  AuthRepository,
  StoredArtifactLimits,
} from "./ports.ts";
import {
  AuditEventCapacityError,
  DEFAULT_AUDIT_EVENT_LIMITS,
  type AuditEventLimits,
  validateAuditEventLimits,
} from "./audit-policy.ts";
import type {
  Account,
  AccountRole,
  AuditEvent,
  AuthSession,
  LoginThrottle,
  LoginIntent,
  SessionExchange,
  CarrierCredential,
} from "./model.ts";

export class InMemoryAuthRepository implements AuthRepository {
  readonly accounts = new Map<string, Account>();
  readonly sessions = new Map<string, AuthSession>();
  readonly loginThrottles = new Map<string, LoginThrottle>();
  readonly auditEvents: AuditEvent[] = [];
  readonly loginIntents = new Map<string, LoginIntent>();
  readonly sessionExchanges = new Map<string, SessionExchange>();
  readonly carrierCredentials = new Map<string, CarrierCredential>();
  readonly #auditEventLimits: AuditEventLimits;

  constructor(options: Readonly<{ auditEventLimits?: AuditEventLimits }> = {}) {
    this.#auditEventLimits = validateAuditEventLimits(
      options.auditEventLimits ?? DEFAULT_AUDIT_EVENT_LIMITS,
    );
  }

  async checkHealth(): Promise<void> {}

  async countAccounts(): Promise<number> {
    return this.accounts.size;
  }

  async createFirstAccount(account: Account, auditEvent: AuditEvent): Promise<boolean> {
    if (this.accounts.size !== 0) return false;
    this.#assertAccountCanBeCreated(account);
    this.#assertAuditEventCanBeAppended(auditEvent);
    this.accounts.set(account.id, account);
    this.auditEvents.push(auditEvent);
    return true;
  }

  async countEnabledAdministrators(): Promise<number> {
    return [...this.accounts.values()].filter(
      (account) => account.enabled && account.roles.includes("ADMIN"),
    ).length;
  }

  async findAccountById(id: string): Promise<Account | undefined> {
    return this.accounts.get(id);
  }

  async findAccountsByIds(ids: readonly string[]): Promise<readonly Account[]> {
    return ids.flatMap((id) => {
      const account = this.accounts.get(id);
      return account === undefined ? [] : [account];
    });
  }

  async findAccountByUsername(username: string): Promise<Account | undefined> {
    return [...this.accounts.values()].find((account) => account.username === username);
  }

  async listAccounts(): Promise<readonly Account[]> {
    return [...this.accounts.values()].sort((left, right) =>
      left.username.localeCompare(right.username));
  }

  async createAccount(input: Readonly<{
    account: Account;
    authorization: AccountMutationAuthorization;
    auditEvent: AuditEvent;
  }>) {
    if (!this.#isAuthorized(input.authorization)) {
      return { status: "ACTOR_NOT_AUTHORIZED" } as const;
    }
    if ([...this.accounts.values()].some((account) => account.username === input.account.username)) {
      return { status: "ALREADY_EXISTS" } as const;
    }
    this.#assertAccountCanBeCreated(input.account);
    this.#assertAuditEventCanBeAppended(input.auditEvent);
    this.accounts.set(input.account.id, input.account);
    this.auditEvents.push(input.auditEvent);
    return { status: "CREATED" } as const;
  }

  async setAccountEnabled(input: Readonly<{
    accountId: string;
    enabled: boolean;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>) {
    if (!this.#isAuthorized(input.authorization)) {
      return { status: "ACTOR_NOT_AUTHORIZED" } as const;
    }
    const account = this.accounts.get(input.accountId);
    if (account === undefined) return { status: "NOT_FOUND" } as const;
    if (
      !input.enabled &&
      account.enabled &&
      account.roles.includes("ADMIN") &&
      this.#enabledAdministratorCount() <= 1
    ) return { status: "LAST_ADMINISTRATOR" } as const;
    this.#assertAuditEventCanBeAppended(input.auditEvent);
    const updated: Account = {
      ...account,
      enabled: input.enabled,
      authVersion: account.authVersion + 1,
      updatedAt: input.updatedAt,
    };
    this.accounts.set(account.id, updated);
    this.#deleteAccountAuthArtifacts(account.id);
    this.auditEvents.push(input.auditEvent);
    return { status: "UPDATED", account: updated } as const;
  }

  async setAccountRoles(input: Readonly<{
    accountId: string;
    roles: readonly AccountRole[];
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>) {
    if (!this.#isAuthorized(input.authorization)) {
      return { status: "ACTOR_NOT_AUTHORIZED" } as const;
    }
    const account = this.accounts.get(input.accountId);
    if (account === undefined) return { status: "NOT_FOUND" } as const;
    if (
      account.enabled &&
      account.roles.includes("ADMIN") &&
      !input.roles.includes("ADMIN") &&
      this.#enabledAdministratorCount() <= 1
    ) return { status: "LAST_ADMINISTRATOR" } as const;
    this.#assertAuditEventCanBeAppended(input.auditEvent);
    const updated: Account = {
      ...account,
      roles: input.roles,
      authVersion: account.authVersion + 1,
      updatedAt: input.updatedAt,
    };
    this.accounts.set(account.id, updated);
    this.#deleteAccountAuthArtifacts(account.id);
    this.auditEvents.push(input.auditEvent);
    return { status: "UPDATED", account: updated } as const;
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
    if (!this.#isAuthorized(input.authorization)) {
      return { status: "ACTOR_NOT_AUTHORIZED" } as const;
    }
    const account = this.accounts.get(input.accountId);
    if (account === undefined) return { status: "NOT_FOUND" } as const;
    if (
      input.expectedAuthVersion !== account.authVersion
    ) return { status: "CONFLICT" } as const;
    this.#assertAuditEventCanBeAppended(input.auditEvent);
    const updated: Account = {
      ...account,
      passwordHash: input.passwordHash,
      mustChangePassword: input.mustChangePassword,
      authVersion: account.authVersion + 1,
      updatedAt: input.updatedAt,
    };
    this.accounts.set(account.id, updated);
    this.#deleteAccountAuthArtifacts(account.id);
    this.auditEvents.push(input.auditEvent);
    return { status: "UPDATED", account: updated } as const;
  }

  async revokeAccountSessions(input: Readonly<{
    accountId: string;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>) {
    if (!this.#isAuthorized(input.authorization)) {
      return { status: "ACTOR_NOT_AUTHORIZED" } as const;
    }
    const account = this.accounts.get(input.accountId);
    if (account === undefined) return { status: "NOT_FOUND" } as const;
    this.#assertAuditEventCanBeAppended(input.auditEvent);
    const updated: Account = {
      ...account,
      authVersion: account.authVersion + 1,
      updatedAt: input.updatedAt,
    };
    this.accounts.set(account.id, updated);
    this.#deleteAccountAuthArtifacts(account.id);
    this.auditEvents.push(input.auditEvent);
    return { status: "UPDATED", account: updated } as const;
  }

  #assertAccountCanBeCreated(account: Account): void {
    const collision = [...this.accounts.values()].find(
      (candidate) => candidate.username === account.username || candidate.id === account.id,
    );
    if (collision !== undefined) throw new Error("username already exists");
  }

  async saveSession(
    session: AuthSession,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean> {
    if (!this.#isCurrentArtifactAccount(session.accountId, session.accountAuthVersion)) {
      return false;
    }
    for (const [id, stored] of this.sessions) {
      if (stored.expiresAt.getTime() <= now.getTime()) this.sessions.delete(id);
    }
    const existing = this.sessions.get(session.id);
    const total = this.sessions.size - (existing === undefined ? 0 : 1);
    const accountCount = [...this.sessions.values()].filter(
      (stored) => stored.id !== session.id && stored.accountId === session.accountId,
    ).length;
    if (total >= limits.global || accountCount >= limits.perAccount) return false;
    this.sessions.set(session.id, session);
    return true;
  }

  async findSessionAccountByTokenDigests(tokenDigests: readonly string[]) {
    for (const tokenDigest of tokenDigests) {
      const session = [...this.sessions.values()].find(
        (candidate) => candidate.tokenDigest === tokenDigest,
      );
      if (session === undefined) continue;
      const account = this.accounts.get(session.accountId);
      return account === undefined ? undefined : { session, account };
    }
    return undefined;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteSessionsForAccount(accountId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.accountId === accountId) this.sessions.delete(id);
    }
  }

  async getLoginThrottle(key: string): Promise<LoginThrottle | undefined> {
    return this.loginThrottles.get(key);
  }

  async recordLoginFailure(input: Readonly<{
    keys: readonly string[];
    now: Date;
    windowStartsAt: Date;
    lockThreshold: number;
    lockedUntil: Date;
    limits: Readonly<{ global: number }>;
  }>) {
    for (const [key, throttle] of this.loginThrottles) {
      if (throttle.updatedAt.getTime() <= input.windowStartsAt.getTime()) {
        this.loginThrottles.delete(key);
      }
    }
    const keys = [...new Set(input.keys)].sort();
    const existingKeys = keys.filter((key) => this.loginThrottles.has(key));
    const availableNewKeys = Math.max(0, input.limits.global - this.loginThrottles.size);
    const newKeys = keys.filter((key) => !this.loginThrottles.has(key));
    const admittedKeys = new Set([
      ...existingKeys,
      ...newKeys.slice(0, availableNewKeys),
    ]);
    const throttles = keys.filter((key) => admittedKeys.has(key)).map((key): LoginThrottle => {
      const stored = this.loginThrottles.get(key);
      const failures = stored !== undefined && stored.updatedAt.getTime() > input.windowStartsAt.getTime()
        ? stored.failures + 1
        : 1;
      return {
        key,
        failures,
        ...(failures >= input.lockThreshold ? { lockedUntil: input.lockedUntil } : {}),
        updatedAt: input.now,
      };
    });
    for (const throttle of throttles) this.loginThrottles.set(throttle.key, throttle);
    return {
      status: admittedKeys.size === keys.length ? "RECORDED" : "CAPACITY_EXHAUSTED",
      throttles,
    } as const;
  }

  async deleteLoginThrottles(keys: readonly string[]): Promise<void> {
    for (const key of new Set(keys)) this.loginThrottles.delete(key);
  }

  async saveLoginIntent(
    intent: LoginIntent,
    now: Date,
    limits: Readonly<{ global: number; perHost: number }>,
  ): Promise<boolean> {
    for (const [id, stored] of this.loginIntents) {
      if (stored.expiresAt.getTime() <= now.getTime()) this.loginIntents.delete(id);
    }
    if (
      this.loginIntents.size >= limits.global ||
      [...this.loginIntents.values()].filter((stored) => stored.targetHost === intent.targetHost).length >= limits.perHost
    ) return false;
    this.loginIntents.set(intent.id, intent);
    return true;
  }

  async consumeLoginIntent(id: string, now: Date): Promise<LoginIntent | undefined> {
    const intent = this.loginIntents.get(id);
    if (intent === undefined || intent.expiresAt.getTime() <= now.getTime()) {
      this.loginIntents.delete(id);
      return undefined;
    }
    this.loginIntents.delete(id);
    return intent;
  }

  async saveSessionExchange(
    exchange: SessionExchange,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean> {
    if (!this.#isCurrentArtifactAccount(exchange.accountId, exchange.accountAuthVersion)) {
      return false;
    }
    for (const [digest, stored] of this.sessionExchanges) {
      if (stored.expiresAt.getTime() <= now.getTime()) this.sessionExchanges.delete(digest);
    }
    const existing = this.sessionExchanges.get(exchange.codeDigest);
    const total = this.sessionExchanges.size - (existing === undefined ? 0 : 1);
    const accountCount = [...this.sessionExchanges.values()].filter(
      (stored) => stored.codeDigest !== exchange.codeDigest &&
        stored.accountId === exchange.accountId,
    ).length;
    if (total >= limits.global || accountCount >= limits.perAccount) return false;
    this.sessionExchanges.set(exchange.codeDigest, exchange);
    return true;
  }

  async consumeSessionExchange(
    codeDigest: string,
    targetHost: string,
    now: Date,
  ): Promise<SessionExchange | undefined> {
    const exchange = this.sessionExchanges.get(codeDigest);
    if (
      exchange === undefined ||
      exchange.targetHost !== targetHost ||
      exchange.expiresAt.getTime() <= now.getTime()
    ) return undefined;
    this.sessionExchanges.delete(codeDigest);
    return exchange;
  }

  async saveCarrierCredential(
    credential: CarrierCredential,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean> {
    if (!this.#isCurrentArtifactAccount(credential.accountId, credential.accountAuthVersion)) {
      return false;
    }
    for (const [id, stored] of this.carrierCredentials) {
      if (stored.expiresAt.getTime() <= now.getTime()) this.carrierCredentials.delete(id);
    }
    const existing = this.carrierCredentials.get(credential.id);
    const total = this.carrierCredentials.size - (existing === undefined ? 0 : 1);
    const accountCount = [...this.carrierCredentials.values()].filter(
      (stored) => stored.id !== credential.id && stored.accountId === credential.accountId,
    ).length;
    if (total >= limits.global || accountCount >= limits.perAccount) return false;
    this.carrierCredentials.set(credential.id, credential);
    return true;
  }

  async consumeCarrierCredential(
    id: string,
    secretDigest: string,
    now: Date,
  ): Promise<CarrierCredential | undefined> {
    const credential = this.carrierCredentials.get(id);
    if (
      credential === undefined ||
      credential.secretDigest !== secretDigest ||
      credential.expiresAt.getTime() <= now.getTime()
    ) return undefined;
    this.carrierCredentials.delete(id);
    return credential;
  }

  async deleteExpiredAuthArtifacts(now: Date, batchSize: number): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new TypeError("batchSize must be a positive safe integer");
    }
    let deleted = 0;
    for (const [id, session] of this.sessions) {
      if (deleted >= batchSize) break;
      if (session.expiresAt.getTime() <= now.getTime()) {
        this.sessions.delete(id);
        deleted += 1;
      }
    }
    for (const [id, intent] of this.loginIntents) {
      if (deleted >= batchSize) break;
      if (intent.expiresAt.getTime() <= now.getTime()) {
        this.loginIntents.delete(id);
        deleted += 1;
      }
    }
    for (const [digest, exchange] of this.sessionExchanges) {
      if (deleted >= batchSize) break;
      if (exchange.expiresAt.getTime() <= now.getTime()) {
        this.sessionExchanges.delete(digest);
        deleted += 1;
      }
    }
    for (const [id, credential] of this.carrierCredentials) {
      if (deleted >= batchSize) break;
      if (credential.expiresAt.getTime() <= now.getTime()) {
        this.carrierCredentials.delete(id);
        deleted += 1;
      }
    }
    for (const [key, throttle] of this.loginThrottles) {
      if (deleted >= batchSize) break;
      if (throttle.updatedAt.getTime() <= now.getTime() - 15 * 60_000) {
        this.loginThrottles.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  #enabledAdministratorCount(): number {
    return [...this.accounts.values()].filter(
      (account) => account.enabled && account.roles.includes("ADMIN"),
    ).length;
  }

  #isAuthorized(authorization: AccountMutationAuthorization): boolean {
    const actor = this.accounts.get(authorization.accountId);
    return actor !== undefined &&
      actor.enabled &&
      actor.authVersion === authorization.authVersion &&
      (authorization.allowPasswordChangeRequired === true || !actor.mustChangePassword) &&
      (authorization.requiredRole === undefined || actor.roles.includes(authorization.requiredRole));
  }

  #isCurrentArtifactAccount(accountId: string, accountAuthVersion: number): boolean {
    const account = this.accounts.get(accountId);
    return account !== undefined &&
      account.enabled &&
      account.authVersion === accountAuthVersion;
  }

  #deleteAccountAuthArtifacts(accountId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.accountId === accountId) this.sessions.delete(id);
    }
    for (const [digest, exchange] of this.sessionExchanges) {
      if (exchange.accountId === accountId) this.sessionExchanges.delete(digest);
    }
    for (const [id, credential] of this.carrierCredentials) {
      if (credential.accountId === accountId) this.carrierCredentials.delete(id);
    }
  }

  #assertAuditEventCanBeAppended(event: AuditEvent): void {
    if (
      this.auditEvents.length >=
        this.#auditEventLimits.global - this.#auditEventLimits.operationalReserve
    ) {
      throw new AuditEventCapacityError();
    }
    if (this.auditEvents.some((candidate) => candidate.id === event.id)) {
      throw new Error("audit event already exists");
    }
  }
}
