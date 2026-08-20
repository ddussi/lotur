import type { AuthRepository } from "./ports.ts";
import type {
  Account,
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

  async checkHealth(): Promise<void> {}

  async countAccounts(): Promise<number> {
    return this.accounts.size;
  }

  async createFirstAccount(account: Account): Promise<boolean> {
    if (this.accounts.size !== 0) return false;
    await this.saveAccount(account);
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

  async findAccountByUsername(username: string): Promise<Account | undefined> {
    return [...this.accounts.values()].find((account) => account.username === username);
  }

  async listAccounts(): Promise<readonly Account[]> {
    return [...this.accounts.values()].sort((left, right) =>
      left.username.localeCompare(right.username));
  }

  async saveAccount(account: Account): Promise<void> {
    const collision = [...this.accounts.values()].find(
      (candidate) => candidate.username === account.username && candidate.id !== account.id,
    );
    if (collision !== undefined) throw new Error("username already exists");
    this.accounts.set(account.id, account);
  }

  async saveSession(session: AuthSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async findSessionByTokenDigest(tokenDigest: string): Promise<AuthSession | undefined> {
    return [...this.sessions.values()].find((session) => session.tokenDigest === tokenDigest);
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

  async saveLoginThrottle(throttle: LoginThrottle): Promise<void> {
    this.loginThrottles.set(throttle.key, throttle);
  }

  async deleteLoginThrottle(key: string): Promise<void> {
    this.loginThrottles.delete(key);
  }

  async saveLoginIntent(intent: LoginIntent): Promise<void> {
    this.loginIntents.set(intent.id, intent);
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

  async saveSessionExchange(exchange: SessionExchange): Promise<void> {
    this.sessionExchanges.set(exchange.codeDigest, exchange);
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

  async saveCarrierCredential(credential: CarrierCredential): Promise<void> {
    this.carrierCredentials.set(credential.id, credential);
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

  async deleteExpiredAuthArtifacts(now: Date): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt.getTime() <= now.getTime()) this.sessions.delete(id);
    }
    for (const [id, intent] of this.loginIntents) {
      if (intent.expiresAt.getTime() <= now.getTime()) this.loginIntents.delete(id);
    }
    for (const [digest, exchange] of this.sessionExchanges) {
      if (exchange.expiresAt.getTime() <= now.getTime()) this.sessionExchanges.delete(digest);
    }
    for (const [id, credential] of this.carrierCredentials) {
      if (credential.expiresAt.getTime() <= now.getTime()) this.carrierCredentials.delete(id);
    }
    for (const [key, throttle] of this.loginThrottles) {
      if (throttle.updatedAt.getTime() <= now.getTime() - 24 * 60 * 60_000) {
        this.loginThrottles.delete(key);
      }
    }
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.auditEvents.push(event);
  }
}
