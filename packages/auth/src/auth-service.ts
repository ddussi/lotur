import { createHmac, randomBytes } from "node:crypto";

import { AuthError } from "./auth-error.ts";
import type {
  Account,
  AccountAuthorization,
  AccountAuthorizationCheck,
  AccountRole,
  AuthenticationEvent,
  AuditAction,
  CarrierCredential,
  CarrierPurpose,
  DeveloperAuthorization,
  AuditEvent,
  Principal,
  SessionExchange,
} from "./model.ts";
import { ACCOUNT_ROLES, canAccessSharedContent } from "./model.ts";
import {
  normalizeDisplayName,
  normalizeUsername,
  validatePassword,
} from "./password-policy.ts";
import type {
  AccountMutationResult,
  AccountMutationAuthorization,
  AuthenticationEventSink,
  AuthRepository,
  LoginIntentLimits,
  LoginThrottleLimits,
  PasswordHasher,
  StoredArtifactLimits,
} from "./ports.ts";

const SESSION_TTL_MS = 12 * 60 * 60_000;
const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_MS = 30_000;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const LOGIN_INTENT_TTL_MS = 5 * 60_000;
const SESSION_EXCHANGE_TTL_MS = 60_000;
const CARRIER_CREDENTIAL_TTL_MS = 60_000;
const DEFAULT_LOGIN_INTENT_LIMITS: LoginIntentLimits = { global: 10_000, perHost: 256 };
export const DEFAULT_LOGIN_THROTTLE_LIMITS: LoginThrottleLimits = { global: 100_000 };
export const DEFAULT_AUTH_ARTIFACT_LIMITS: AuthArtifactLimits = {
  sessions: { global: 100_000, perAccount: 64 },
  sessionExchanges: { global: 10_000, perAccount: 256 },
  carrierCredentials: { global: 10_000, perAccount: 128 },
};
const AUTH_ARTIFACT_CLEANUP_BATCH_SIZE = 500;
const AUTH_ARTIFACT_CLEANUP_MAX_BATCHES = 10;
const AUTHORIZATION_ACCOUNT_BATCH_SIZE = 512;
const AUTHORIZATION_ACCOUNT_QUERY_CONCURRENCY = 4;

export type AuthServiceDependencies = Readonly<{
  repository: AuthRepository;
  passwordHasher: PasswordHasher;
  sessionHmacKey: Uint8Array;
  previousSessionHmacKeys?: readonly Uint8Array[];
  dummyPasswordHash: string;
  now?: () => Date;
  createId?: () => string;
  createSecret?: () => string;
  authenticationEventSink: AuthenticationEventSink;
  loginIntentLimits?: LoginIntentLimits;
  loginThrottleLimits?: LoginThrottleLimits;
  authArtifactLimits?: AuthArtifactLimits;
}>;

export type AuthArtifactLimits = Readonly<{
  sessions: StoredArtifactLimits;
  sessionExchanges: StoredArtifactLimits;
  carrierCredentials: StoredArtifactLimits;
}>;

export class AuthService {
  readonly #repository: AuthRepository;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessionHmacKeys: readonly Uint8Array[];
  readonly #dummyPasswordHash: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #createSecret: () => string;
  readonly #authenticationEventSink: AuthenticationEventSink;
  readonly #loginIntentLimits: LoginIntentLimits;
  readonly #loginThrottleLimits: LoginThrottleLimits;
  readonly #authArtifactLimits: AuthArtifactLimits;

  constructor(dependencies: AuthServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#passwordHasher = dependencies.passwordHasher;
    const previousSessionHmacKeys = dependencies.previousSessionHmacKeys ?? [];
    if (previousSessionHmacKeys.length > 3) {
      throw new TypeError("at most 3 previous session HMAC keys are supported");
    }
    const sessionHmacKeys = [
      dependencies.sessionHmacKey,
      ...previousSessionHmacKeys,
    ];
    if (sessionHmacKeys.some((key) => key.byteLength < 32 || key.byteLength > 128)) {
      throw new TypeError("session HMAC keys must contain between 32 and 128 bytes");
    }
    const encodedSessionHmacKeys = sessionHmacKeys.map((key) =>
      Buffer.from(key).toString("base64"));
    if (new Set(encodedSessionHmacKeys).size !== encodedSessionHmacKeys.length) {
      throw new TypeError("session HMAC keys must be unique");
    }
    this.#sessionHmacKeys = sessionHmacKeys.map((key) => Uint8Array.from(key));
    this.#dummyPasswordHash = dependencies.dummyPasswordHash;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? (() => randomBytes(16).toString("hex"));
    this.#createSecret = dependencies.createSecret ?? (() => randomBytes(24).toString("base64url"));
    this.#authenticationEventSink = dependencies.authenticationEventSink;
    this.#loginIntentLimits = validateLoginIntentLimits(
      dependencies.loginIntentLimits ?? DEFAULT_LOGIN_INTENT_LIMITS,
    );
    this.#loginThrottleLimits = validateLoginThrottleLimits(
      dependencies.loginThrottleLimits ?? DEFAULT_LOGIN_THROTTLE_LIMITS,
    );
    this.#authArtifactLimits = validateAuthArtifactLimits(
      dependencies.authArtifactLimits ?? DEFAULT_AUTH_ARTIFACT_LIMITS,
    );
  }

  async bootstrapAdministrator(input: Readonly<{ username: string; displayName: string }>) {
    const result = await this.#buildAccount({
      username: input.username,
      displayName: input.displayName,
      roles: ["ADMIN"],
    });
    const auditEvent = this.#auditEvent("ACCOUNT_BOOTSTRAPPED", undefined, result.account.id);
    if (!await this.#repository.createFirstAccount(result.account, auditEvent)) {
      throw new AuthError("BOOTSTRAP_CLOSED", "최초 관리자 생성은 계정이 없을 때만 가능합니다.");
    }
    return result;
  }

  async authenticate(input: Readonly<{
    username: string;
    password: string;
    remoteAddress: string;
  }>): Promise<Readonly<{ principal: Principal; sessionToken: string }>> {
    const now = this.#now();
    const account = await this.#verifyCredentials(input, now);
    const login = await this.#issueSession(
      account,
      now,
      "control",
    );
    this.#writeAuthenticationEvent({
      action: "LOGIN_SUCCEEDED",
      occurredAt: now,
      identityRef: this.#throttleKey("identity", account.username),
      remoteRef: this.#throttleKey("remote", input.remoteAddress),
      accountId: account.id,
    });
    return login;
  }

  async verifyAdministratorCredentials(input: Readonly<{
    username: string;
    password: string;
    remoteAddress: string;
  }>): Promise<AccountAuthorization> {
    const now = this.#now();
    const account = await this.#verifyCredentials(input, now);
    if (account.mustChangePassword) {
      throw new AuthError("PASSWORD_CHANGE_REQUIRED", "먼저 change-password 명령을 실행하세요.");
    }
    if (!account.roles.includes("ADMIN")) {
      throw new AuthError("FORBIDDEN", "관리자 권한이 필요합니다.");
    }
    this.#writeAuthenticationEvent({
      action: "LOGIN_SUCCEEDED",
      occurredAt: now,
      identityRef: this.#throttleKey("identity", account.username),
      remoteRef: this.#throttleKey("remote", input.remoteAddress),
      accountId: account.id,
    });
    return { accountId: account.id, authVersion: account.authVersion };
  }

  async #verifyCredentials(input: Readonly<{
    username: string;
    password: string;
    remoteAddress: string;
  }>, now: Date, knownAccount?: Account): Promise<Account> {
    let username: string | undefined;
    let throttleIdentity: string;
    if (knownAccount === undefined) {
      try {
        username = normalizeUsername(input.username);
        throttleIdentity = username;
      } catch {
        username = undefined;
        throttleIdentity = `invalid:${input.username.trim().toLowerCase().slice(0, 64)}`;
      }
    } else {
      username = knownAccount.username;
      throttleIdentity = knownAccount.username;
    }
    const account = knownAccount ?? (username === undefined
      ? undefined
      : await this.#repository.findAccountByUsername(username));
    const throttleKeys = [
      this.#throttleKey("identity", throttleIdentity),
      this.#throttleKey("remote", input.remoteAddress),
    ];
    const storedThrottles = await Promise.all(
      throttleKeys.map((key) => this.#repository.getLoginThrottle(key)),
    );
    const throttles = storedThrottles.map((throttle) =>
      throttle !== undefined && throttle.updatedAt.getTime() > now.getTime() - LOGIN_FAILURE_WINDOW_MS
        ? throttle
        : undefined);
    if (throttles.some((throttle) =>
      throttle?.lockedUntil !== undefined && throttle.lockedUntil.getTime() > now.getTime())) {
      this.#writeAuthenticationEvent({
        action: "LOGIN_FAILED",
        occurredAt: now,
        identityRef: throttleKeys[0]!,
        remoteRef: throttleKeys[1]!,
        ...(account === undefined ? {} : { accountId: account.id }),
        reason: "LOGIN_THROTTLED",
      });
      throw new AuthError("LOGIN_THROTTLED", "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.");
    }

    const passwordMatches = await this.#passwordHasher.verify(
      account?.passwordHash ?? this.#dummyPasswordHash,
      input.password,
    );
    if (account === undefined || !account.enabled || !passwordMatches) {
      const recorded = await this.#repository.recordLoginFailure({
        keys: throttleKeys,
        now,
        windowStartsAt: new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS),
        lockThreshold: LOGIN_LOCK_THRESHOLD,
        lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MS),
        limits: this.#loginThrottleLimits,
      });
      this.#writeAuthenticationEvent({
        action: "LOGIN_FAILED",
        occurredAt: now,
        identityRef: throttleKeys[0]!,
        remoteRef: throttleKeys[1]!,
        ...(account === undefined ? {} : { accountId: account.id }),
        reason: recorded.status === "CAPACITY_EXHAUSTED"
          ? "THROTTLE_CAPACITY"
          : "INVALID_CREDENTIALS",
      });
      if (recorded.status === "CAPACITY_EXHAUSTED") {
        throw new AuthError("AUTH_CAPACITY", "로그인 제한 저장소 용량이 소진되었습니다.");
      }
      throw new AuthError("INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다.");
    }

    await this.#repository.deleteLoginThrottles(throttleKeys);
    return account;
  }

  async createLoginIntent(targetHost: string, targetPath: string): Promise<string> {
    if (targetHost.length < 1 || targetHost.length > 253 || !targetPath.startsWith("/") || targetPath.length > 4096) {
      throw new AuthError("INVALID_ACCOUNT_INPUT", "올바르지 않은 로그인 복귀 대상입니다.");
    }
    const id = this.#createSecret();
    const now = this.#now();
    const saved = await this.#repository.saveLoginIntent({
      id,
      targetHost,
      targetPath,
      expiresAt: new Date(now.getTime() + LOGIN_INTENT_TTL_MS),
    }, now, this.#loginIntentLimits);
    if (!saved) {
      throw new AuthError("LOGIN_INTENT_CAPACITY", "로그인 요청이 많습니다. 잠시 후 다시 시도하세요.");
    }
    return id;
  }

  async createSessionExchange(
    principal: Principal,
    intentId: string,
  ): Promise<Readonly<{ code: string; targetHost: string; targetPath: string }>> {
    const account = await this.#requireCurrentAccount(principal);
    if (!canAccessSharedContent(account.roles)) {
      throw new AuthError("FORBIDDEN", "공유 화면 접근 권한이 필요합니다.");
    }
    const intent = await this.#repository.consumeLoginIntent(intentId, this.#now());
    if (intent === undefined) throw new AuthError("FORBIDDEN", "로그인 요청이 만료됐거나 이미 사용됐습니다.");
    const code = this.#createSecret();
    const now = this.#now();
    const saved = await this.#repository.saveSessionExchange({
      codeDigest: this.#digestSessionToken(`exchange:${code}`),
      accountId: account.id,
      accountAuthVersion: account.authVersion,
      targetHost: intent.targetHost,
      targetPath: intent.targetPath,
      expiresAt: new Date(now.getTime() + SESSION_EXCHANGE_TTL_MS),
    }, now, this.#authArtifactLimits.sessionExchanges);
    if (!saved) {
      await this.#requireCurrentArtifactAccount(account);
      throw new AuthError("AUTH_CAPACITY", "인증 교환 요청이 많습니다. 잠시 후 다시 시도하세요.");
    }
    return { code, targetHost: intent.targetHost, targetPath: intent.targetPath };
  }

  async consumeSessionExchange(
    code: string,
    targetHost: string,
  ): Promise<Readonly<{ principal: Principal; sessionToken: string; targetPath: string }>> {
    let exchange: SessionExchange | undefined;
    for (const digest of this.#digestSessionTokenCandidates(`exchange:${code}`)) {
      exchange = await this.#repository.consumeSessionExchange(
        digest,
        targetHost,
        this.#now(),
      );
      if (exchange !== undefined) break;
    }
    if (exchange === undefined) throw new AuthError("FORBIDDEN", "세션 교환 코드가 올바르지 않습니다.");
    const account = await this.#requireAccount(exchange.accountId);
    if (
      !account.enabled ||
      account.mustChangePassword ||
      account.authVersion !== exchange.accountAuthVersion ||
      !canAccessSharedContent(account.roles)
    ) {
      throw new AuthError("FORBIDDEN", "공유 화면 접근 권한이 필요합니다.");
    }
    return {
      ...await this.#issueSession(account, this.#now(), `content:${exchange.targetHost}`),
      targetPath: exchange.targetPath,
    };
  }

  async issueCarrierCredential(
    principal: Principal,
    input: Readonly<{ purpose: CarrierPurpose; tunnelId: string }>,
  ): Promise<string> {
    const account = await this.#requireCurrentAccount(principal);
    if (!account.roles.includes("DEVELOPER")) {
      throw new AuthError("FORBIDDEN", "개발자 권한이 필요합니다.");
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.tunnelId)) {
      throw new AuthError("INVALID_ACCOUNT_INPUT", "올바르지 않은 Tunnel ID입니다.");
    }
    const id = this.#createId();
    const secret = this.#createSecret();
    const now = this.#now();
    const saved = await this.#repository.saveCarrierCredential({
      id,
      secretDigest: this.#digestSessionToken(`carrier:${id}:${secret}`),
      accountId: account.id,
      accountAuthVersion: account.authVersion,
      purpose: input.purpose,
      tunnelId: input.tunnelId,
      expiresAt: new Date(now.getTime() + CARRIER_CREDENTIAL_TTL_MS),
    }, now, this.#authArtifactLimits.carrierCredentials);
    if (!saved) {
      await this.#requireCurrentArtifactAccount(account);
      throw new AuthError("AUTH_CAPACITY", "Carrier 인증 요청이 많습니다. 잠시 후 다시 시도하세요.");
    }
    return `${id}.${secret}`;
  }

  async consumeCarrierCredential(token: string): Promise<DeveloperAuthorization> {
    const separator = token.indexOf(".");
    if (separator < 1 || token.length > 512) throw new AuthError("FORBIDDEN", "Carrier 인증에 실패했습니다.");
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    let credential: CarrierCredential | undefined;
    for (const digest of this.#digestSessionTokenCandidates(`carrier:${id}:${secret}`)) {
      credential = await this.#repository.consumeCarrierCredential(
        id,
        digest,
        this.#now(),
      );
      if (credential !== undefined) break;
    }
    if (credential === undefined) throw new AuthError("FORBIDDEN", "Carrier 인증에 실패했습니다.");
    const account = await this.#requireAccount(credential.accountId);
    if (
      !account.enabled ||
      account.mustChangePassword ||
      !account.roles.includes("DEVELOPER") ||
      account.authVersion !== credential.accountAuthVersion
    ) throw new AuthError("FORBIDDEN", "Carrier 인증에 실패했습니다.");
    return {
      accountId: account.id,
      accountAuthVersion: account.authVersion,
      username: account.username,
      purpose: credential.purpose,
      tunnelId: credential.tunnelId,
    };
  }

  async isAccountAuthorized(
    accountId: string,
    accountAuthVersion: number,
    role: AccountRole,
  ): Promise<boolean> {
    const [authorized] = await this.areAccountsAuthorized([{
      accountId,
      accountAuthVersion,
      role,
    }]);
    return authorized ?? false;
  }

  async areAccountsAuthorized(
    checks: readonly AccountAuthorizationCheck[],
  ): Promise<readonly boolean[]> {
    if (checks.length === 0) return [];
    const accountIds = [...new Set(checks.map((check) => check.accountId))];
    const batches = Array.from(
      { length: Math.ceil(accountIds.length / AUTHORIZATION_ACCOUNT_BATCH_SIZE) },
      (_, index) => accountIds.slice(
        index * AUTHORIZATION_ACCOUNT_BATCH_SIZE,
        (index + 1) * AUTHORIZATION_ACCOUNT_BATCH_SIZE,
      ),
    );
    const accounts = new Map<string, Account>();
    let nextBatch = 0;
    const workerCount = Math.min(AUTHORIZATION_ACCOUNT_QUERY_CONCURRENCY, batches.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch];
        nextBatch += 1;
        if (batch === undefined) return;
        for (const account of await this.#repository.findAccountsByIds(batch)) {
          accounts.set(account.id, account);
        }
      }
    }));
    return checks.map((check) => {
      const account = accounts.get(check.accountId);
      return account !== undefined && account.enabled && !account.mustChangePassword &&
        account.authVersion === check.accountAuthVersion && account.roles.includes(check.role);
    });
  }

  async cleanupExpiredArtifacts(): Promise<void> {
    const now = this.#now();
    for (let batch = 0; batch < AUTH_ARTIFACT_CLEANUP_MAX_BATCHES; batch += 1) {
      const deleted = await this.#repository.deleteExpiredAuthArtifacts(
        now,
        AUTH_ARTIFACT_CLEANUP_BATCH_SIZE,
      );
      if (deleted < AUTH_ARTIFACT_CLEANUP_BATCH_SIZE) break;
    }
  }

  async checkHealth(): Promise<void> {
    await this.#repository.checkHealth();
  }

  async resolveSession(
    sessionToken: string,
    expectedAudience = "control",
  ): Promise<Principal | undefined> {
    if (sessionToken.length < 20 || sessionToken.length > 512) return undefined;
    const resolved = await this.#repository.findSessionAccountByTokenDigests(
      this.#digestSessionTokenCandidates(sessionToken),
    );
    if (resolved === undefined) return undefined;
    const { session, account } = resolved;
    if (session.audience !== expectedAudience) return undefined;
    if (
      !account.enabled ||
      account.authVersion !== session.accountAuthVersion ||
      session.expiresAt.getTime() <= this.#now().getTime()
    ) {
      await this.#repository.deleteSession(session.id);
      return undefined;
    }
    return toPrincipal(account, session.id);
  }

  async logout(principal: Principal): Promise<void> {
    await this.#repository.deleteSession(principal.sessionId);
  }

  async changeOwnPassword(
    principal: Principal,
    input: Readonly<{ currentPassword: string; newPassword: string }>,
  ): Promise<void> {
    const account = await this.#requireEnabledAccount(principal);
    await this.#verifyCredentials({
      username: account.username,
      password: input.currentPassword,
      remoteAddress: `session:${principal.sessionId}`,
    }, this.#now(), account);
    validatePassword(input.newPassword);
    await this.#replacePassword({
      account,
      password: input.newPassword,
      mustChangePassword: false,
      expectedAuthVersion: account.authVersion,
      action: "PASSWORD_CHANGED",
      actorAccountId: account.id,
      authorization: {
        accountId: principal.accountId,
        authVersion: principal.authVersion,
        allowPasswordChangeRequired: true,
      },
    });
  }

  async createAccount(
    actor: AccountAuthorization,
    input: Readonly<{ username: string; displayName: string; roles: readonly AccountRole[] }>,
  ) {
    await this.#requireAdministrator(actor);
    return this.#createAccount(actor, input);
  }

  async listAccounts(actor: AccountAuthorization): Promise<readonly Account[]> {
    await this.#requireAdministrator(actor);
    return this.#repository.listAccounts();
  }

  async setAccountEnabled(actor: AccountAuthorization, accountId: string, enabled: boolean): Promise<Account> {
    await this.#requireAdministrator(actor);
    const result = await this.#repository.setAccountEnabled({
      accountId,
      enabled,
      authorization: administratorAuthorization(actor),
      updatedAt: this.#now(),
      auditEvent: this.#auditEvent(
        enabled ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED",
        actor.accountId,
        accountId,
      ),
    });
    return this.#requireUpdatedAccount(result);
  }

  async setAccountRoles(
    actor: AccountAuthorization,
    accountId: string,
    roles: readonly AccountRole[],
  ): Promise<Account> {
    await this.#requireAdministrator(actor);
    const normalizedRoles = normalizeRoles(roles);
    const result = await this.#repository.setAccountRoles({
      accountId,
      roles: normalizedRoles,
      authorization: administratorAuthorization(actor),
      updatedAt: this.#now(),
      auditEvent: this.#auditEvent("ACCOUNT_ROLES_CHANGED", actor.accountId, accountId),
    });
    return this.#requireUpdatedAccount(result);
  }

  async resetPassword(actor: AccountAuthorization, accountId: string) {
    await this.#requireAdministrator(actor);
    const account = await this.#requireAccount(accountId);
    const temporaryPassword = this.#createSecret();
    const updated = await this.#replacePassword({
      account,
      password: temporaryPassword,
      mustChangePassword: true,
      expectedAuthVersion: account.authVersion,
      authorization: administratorAuthorization(actor),
      action: "PASSWORD_RESET",
      actorAccountId: actor.accountId,
    });
    return { account: updated, temporaryPassword };
  }

  async revokeSessions(actor: AccountAuthorization, accountId: string): Promise<void> {
    await this.#requireAdministrator(actor);
    const result = await this.#repository.revokeAccountSessions({
      accountId,
      authorization: administratorAuthorization(actor),
      updatedAt: this.#now(),
      auditEvent: this.#auditEvent("SESSIONS_REVOKED", actor.accountId, accountId),
    });
    this.#requireUpdatedAccount(result);
  }

  async #createAccount(actor: AccountAuthorization, input: Readonly<{
    username: string;
    displayName: string;
    roles: readonly AccountRole[];
  }>) {
    const result = await this.#buildAccount(input);
    const created = await this.#repository.createAccount({
      account: result.account,
      authorization: administratorAuthorization(actor),
      auditEvent: this.#auditEvent("ACCOUNT_CREATED", actor.accountId, result.account.id),
    });
    if (created.status === "ACTOR_NOT_AUTHORIZED") {
      throw new AuthError("FORBIDDEN", "관리자 권한이 필요합니다.");
    }
    if (created.status === "ALREADY_EXISTS") {
      throw new AuthError("ACCOUNT_EXISTS", "이미 사용 중인 아이디입니다.");
    }
    return result;
  }

  async #buildAccount(input: Readonly<{
    username: string;
    displayName: string;
    roles: readonly AccountRole[];
  }>) {
    const username = normalizeUsername(input.username);
    const displayName = normalizeDisplayName(input.displayName);
    const roles = normalizeRoles(input.roles);
    if (await this.#repository.findAccountByUsername(username) !== undefined) {
      throw new AuthError("ACCOUNT_EXISTS", "이미 사용 중인 아이디입니다.");
    }
    const now = this.#now();
    const temporaryPassword = this.#createSecret();
    const account: Account = {
      id: this.#createId(),
      username,
      displayName,
      roles,
      passwordHash: await this.#passwordHasher.hash(temporaryPassword),
      enabled: true,
      mustChangePassword: true,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    return { account, temporaryPassword };
  }

  async #replacePassword(input: Readonly<{
    account: Account;
    password: string;
    mustChangePassword: boolean;
    expectedAuthVersion: number;
    action: "PASSWORD_CHANGED" | "PASSWORD_RESET";
    actorAccountId: string;
    authorization: AccountMutationAuthorization;
  }>): Promise<Account> {
    const result = await this.#repository.replaceAccountPassword({
      accountId: input.account.id,
      passwordHash: await this.#passwordHasher.hash(input.password),
      mustChangePassword: input.mustChangePassword,
      expectedAuthVersion: input.expectedAuthVersion,
      authorization: input.authorization,
      updatedAt: this.#now(),
      auditEvent: this.#auditEvent(
        input.action,
        input.actorAccountId,
        input.account.id,
      ),
    });
    return this.#requireUpdatedAccount(result);
  }

  async #issueSession(
    account: Account,
    now: Date,
    audience = "control",
  ) {
    const sessionId = this.#createId();
    const sessionToken = `${sessionId}.${this.#createSecret()}`;
    const saved = await this.#repository.saveSession({
      id: sessionId,
      tokenDigest: this.#digestSessionToken(sessionToken),
      accountId: account.id,
      accountAuthVersion: account.authVersion,
      audience,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    }, now, this.#authArtifactLimits.sessions);
    if (!saved) {
      await this.#requireCurrentArtifactAccount(account);
      throw new AuthError("AUTH_CAPACITY", "활성 인증 세션이 너무 많습니다.");
    }
    return { principal: toPrincipal(account, sessionId), sessionToken };
  }

  async #requireAdministrator(principal: AccountAuthorization): Promise<Account> {
    const account = await this.#requireCurrentAccount(principal);
    if (!account.roles.includes("ADMIN")) {
      throw new AuthError("FORBIDDEN", "관리자 권한이 필요합니다.");
    }
    return account;
  }

  async #requireCurrentAccount(principal: AccountAuthorization): Promise<Account> {
    const account = await this.#requireEnabledAccount(principal);
    if (account.mustChangePassword) {
      throw new AuthError("PASSWORD_CHANGE_REQUIRED", "먼저 임시 비밀번호를 변경해야 합니다.");
    }
    return account;
  }

  async #requireEnabledAccount(principal: AccountAuthorization): Promise<Account> {
    const account = await this.#repository.findAccountById(principal.accountId);
    if (
      account === undefined ||
      !account.enabled ||
      account.authVersion !== principal.authVersion
    ) {
      throw new AuthError("FORBIDDEN", "활성 계정이 아닙니다.");
    }
    return account;
  }

  async #requireCurrentArtifactAccount(
    expected: Readonly<Pick<Account, "id" | "authVersion">>,
  ): Promise<void> {
    const account = await this.#repository.findAccountById(expected.id);
    if (
      account === undefined ||
      !account.enabled ||
      account.authVersion !== expected.authVersion
    ) {
      throw new AuthError("FORBIDDEN", "활성 계정이 아닙니다.");
    }
  }

  async #requireAccount(accountId: string): Promise<Account> {
    const account = await this.#repository.findAccountById(accountId);
    if (account === undefined) throw new AuthError("ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다.");
    return account;
  }

  #digestSessionToken(token: string): string {
    return this.#digestSessionTokenWithKey(this.#sessionHmacKeys[0]!, token);
  }

  #digestSessionTokenCandidates(token: string): readonly string[] {
    return this.#sessionHmacKeys.map((key) => this.#digestSessionTokenWithKey(key, token));
  }

  #digestSessionTokenWithKey(key: Uint8Array, token: string): string {
    return createHmac("sha256", key).update(token).digest("base64url");
  }

  #throttleKey(scope: "identity" | "remote", value: string): string {
    return createHmac("sha256", this.#sessionHmacKeys[0]!)
      .update(`${scope}\0${value}`)
      .digest("base64url");
  }

  #writeAuthenticationEvent(event: AuthenticationEvent): void {
    try {
      this.#authenticationEventSink.write(event);
    } catch {
      try {
        this.#authenticationEventSink.reportFailure();
      } catch {
        console.error(JSON.stringify({
          event: "authentication_event_sink_failure_unreported",
        }));
      }
    }
  }

  #auditEvent(
    action: AuditAction,
    actorAccountId?: string,
    targetAccountId?: string,
    metadata: Readonly<Record<string, string | number | boolean>> = {},
  ): AuditEvent {
    return {
      id: this.#createId(),
      action,
      ...(actorAccountId === undefined ? {} : { actorAccountId }),
      ...(targetAccountId === undefined ? {} : { targetAccountId }),
      occurredAt: this.#now(),
      metadata,
    };
  }

  #requireUpdatedAccount(result: AccountMutationResult): Account {
    if (result.status === "UPDATED") return result.account;
    if (result.status === "LAST_ADMINISTRATOR") {
      throw new AuthError("LAST_ADMINISTRATOR", "마지막 활성 관리자는 비활성화하거나 관리자 권한을 제거할 수 없습니다.");
    }
    if (result.status === "CONFLICT") {
      throw new AuthError("ACCOUNT_CONFLICT", "계정이 다른 요청에서 변경됐습니다. 다시 시도하세요.");
    }
    if (result.status === "ACTOR_NOT_AUTHORIZED") {
      throw new AuthError("FORBIDDEN", "현재 계정으로 이 작업을 수행할 수 없습니다.");
    }
    throw new AuthError("ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다.");
  }
}

function validateLoginIntentLimits(limits: LoginIntentLimits): LoginIntentLimits {
  if (
    !Number.isSafeInteger(limits.global) || limits.global < 1 ||
    !Number.isSafeInteger(limits.perHost) || limits.perHost < 1 ||
    limits.perHost > limits.global
  ) {
    throw new TypeError("login intent limits must be positive safe integers and perHost must not exceed global");
  }
  return limits;
}

function validateLoginThrottleLimits(limits: LoginThrottleLimits): LoginThrottleLimits {
  if (!Number.isSafeInteger(limits.global) || limits.global < 2) {
    throw new TypeError("login throttle global limit must be a safe integer of at least 2");
  }
  return { global: limits.global };
}

function validateAuthArtifactLimits(limits: AuthArtifactLimits): AuthArtifactLimits {
  return {
    sessions: validateStoredArtifactLimits(limits.sessions, "session"),
    sessionExchanges: validateStoredArtifactLimits(
      limits.sessionExchanges,
      "session exchange",
    ),
    carrierCredentials: validateStoredArtifactLimits(
      limits.carrierCredentials,
      "Carrier credential",
    ),
  };
}

function validateStoredArtifactLimits(
  limits: StoredArtifactLimits,
  name: string,
): StoredArtifactLimits {
  if (
    !Number.isSafeInteger(limits.global) || limits.global < 1 ||
    !Number.isSafeInteger(limits.perAccount) || limits.perAccount < 1 ||
    limits.perAccount > limits.global
  ) {
    throw new TypeError(
      `${name} limits must be positive safe integers and perAccount must not exceed global`,
    );
  }
  return { global: limits.global, perAccount: limits.perAccount };
}

function normalizeRoles(roles: readonly AccountRole[]): readonly AccountRole[] {
  const unique = [...new Set(roles)];
  if (unique.length === 0 || unique.some((role) => !ACCOUNT_ROLES.includes(role))) {
    throw new AuthError("INVALID_ACCOUNT_INPUT", "하나 이상의 올바른 권한이 필요합니다.");
  }
  return ACCOUNT_ROLES.filter((role) => unique.includes(role));
}

function administratorAuthorization(
  actor: AccountAuthorization,
): AccountMutationAuthorization {
  return {
    accountId: actor.accountId,
    authVersion: actor.authVersion,
    requiredRole: "ADMIN",
  };
}

function toPrincipal(account: Account, sessionId: string): Principal {
  return {
    accountId: account.id,
    username: account.username,
    displayName: account.displayName,
    roles: account.roles,
    mustChangePassword: account.mustChangePassword,
    authVersion: account.authVersion,
    sessionId,
  };
}
