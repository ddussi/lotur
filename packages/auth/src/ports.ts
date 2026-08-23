import type {
  Account,
  AccountAuthorization,
  AccountRole,
  AuthenticationEvent,
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

export interface AuthenticationEventSink {
  write(event: AuthenticationEvent): void;
  reportFailure(): void;
}

export type AccountMutationResult =
  | Readonly<{ status: "UPDATED"; account: Account }>
  | Readonly<{
      status: "NOT_FOUND" | "LAST_ADMINISTRATOR" | "CONFLICT" | "ACTOR_NOT_AUTHORIZED";
    }>;

export type AccountMutationAuthorization = AccountAuthorization & Readonly<{
  requiredRole?: AccountRole;
  allowPasswordChangeRequired?: boolean;
}>;

export type AccountCreationResult =
  | Readonly<{ status: "CREATED" }>
  | Readonly<{ status: "ACTOR_NOT_AUTHORIZED" | "ALREADY_EXISTS" }>;

export type LoginIntentLimits = Readonly<{
  global: number;
  perHost: number;
}>;

export type LoginThrottleLimits = Readonly<{
  global: number;
}>;

export type LoginThrottleRecordResult = Readonly<{
  status: "RECORDED" | "CAPACITY_EXHAUSTED";
  throttles: readonly LoginThrottle[];
}>;

export type StoredArtifactLimits = Readonly<{
  global: number;
  perAccount: number;
}>;

export interface AuthRepository {
  checkHealth(): Promise<void>;
  countAccounts(): Promise<number>;
  createFirstAccount(account: Account, auditEvent: AuditEvent): Promise<boolean>;
  countEnabledAdministrators(): Promise<number>;
  findAccountById(id: string): Promise<Account | undefined>;
  findAccountByUsername(username: string): Promise<Account | undefined>;
  listAccounts(): Promise<readonly Account[]>;
  createAccount(input: Readonly<{
    account: Account;
    authorization: AccountMutationAuthorization;
    auditEvent: AuditEvent;
  }>): Promise<AccountCreationResult>;
  setAccountEnabled(input: Readonly<{
    accountId: string;
    enabled: boolean;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>): Promise<AccountMutationResult>;
  setAccountRoles(input: Readonly<{
    accountId: string;
    roles: readonly AccountRole[];
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>): Promise<AccountMutationResult>;
  replaceAccountPassword(input: Readonly<{
    accountId: string;
    passwordHash: string;
    mustChangePassword: boolean;
    expectedAuthVersion: number;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>): Promise<AccountMutationResult>;
  revokeAccountSessions(input: Readonly<{
    accountId: string;
    authorization: AccountMutationAuthorization;
    updatedAt: Date;
    auditEvent: AuditEvent;
  }>): Promise<AccountMutationResult>;
  saveSession(
    session: AuthSession,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean>;
  findSessionByTokenDigest(tokenDigest: string): Promise<AuthSession | undefined>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsForAccount(accountId: string): Promise<void>;
  getLoginThrottle(key: string): Promise<LoginThrottle | undefined>;
  recordLoginFailure(input: Readonly<{
    keys: readonly string[];
    now: Date;
    windowStartsAt: Date;
    lockThreshold: number;
    lockedUntil: Date;
    limits: LoginThrottleLimits;
  }>): Promise<LoginThrottleRecordResult>;
  deleteLoginThrottles(keys: readonly string[]): Promise<void>;
  saveLoginIntent(
    intent: LoginIntent,
    now: Date,
    limits: LoginIntentLimits,
  ): Promise<boolean>;
  consumeLoginIntent(id: string, now: Date): Promise<LoginIntent | undefined>;
  saveSessionExchange(
    exchange: SessionExchange,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean>;
  consumeSessionExchange(
    codeDigest: string,
    targetHost: string,
    now: Date,
  ): Promise<SessionExchange | undefined>;
  saveCarrierCredential(
    credential: CarrierCredential,
    now: Date,
    limits: StoredArtifactLimits,
  ): Promise<boolean>;
  consumeCarrierCredential(
    id: string,
    secretDigest: string,
    now: Date,
  ): Promise<CarrierCredential | undefined>;
  deleteExpiredAuthArtifacts(now: Date, batchSize: number): Promise<number>;
}
