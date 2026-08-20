import type {
  Account,
  AuditEvent,
  AuthSession,
  LoginThrottle,
  LoginIntent,
  SessionExchange,
  CarrierCredential,
} from "./model.ts";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AuthRepository {
  checkHealth(): Promise<void>;
  countAccounts(): Promise<number>;
  createFirstAccount(account: Account): Promise<boolean>;
  countEnabledAdministrators(): Promise<number>;
  findAccountById(id: string): Promise<Account | undefined>;
  findAccountByUsername(username: string): Promise<Account | undefined>;
  listAccounts(): Promise<readonly Account[]>;
  saveAccount(account: Account): Promise<void>;
  saveSession(session: AuthSession): Promise<void>;
  findSessionByTokenDigest(tokenDigest: string): Promise<AuthSession | undefined>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsForAccount(accountId: string): Promise<void>;
  getLoginThrottle(key: string): Promise<LoginThrottle | undefined>;
  saveLoginThrottle(throttle: LoginThrottle): Promise<void>;
  deleteLoginThrottle(key: string): Promise<void>;
  saveLoginIntent(intent: LoginIntent): Promise<void>;
  consumeLoginIntent(id: string, now: Date): Promise<LoginIntent | undefined>;
  saveSessionExchange(exchange: SessionExchange): Promise<void>;
  consumeSessionExchange(
    codeDigest: string,
    targetHost: string,
    now: Date,
  ): Promise<SessionExchange | undefined>;
  saveCarrierCredential(credential: CarrierCredential): Promise<void>;
  consumeCarrierCredential(
    id: string,
    secretDigest: string,
    now: Date,
  ): Promise<CarrierCredential | undefined>;
  deleteExpiredAuthArtifacts(now: Date): Promise<void>;
  appendAuditEvent(event: AuditEvent): Promise<void>;
}
