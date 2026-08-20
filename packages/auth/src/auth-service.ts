import { createHmac, randomBytes } from "node:crypto";

import { AuthError } from "./auth-error.ts";
import type {
  Account,
  AccountRole,
  AuditAction,
  CarrierPurpose,
  DeveloperAuthorization,
  Principal,
} from "./model.ts";
import { ACCOUNT_ROLES } from "./model.ts";
import {
  normalizeDisplayName,
  normalizeUsername,
  validatePassword,
} from "./password-policy.ts";
import type { AuthRepository, PasswordHasher } from "./ports.ts";

const SESSION_TTL_MS = 12 * 60 * 60_000;
const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_MS = 30_000;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const LOGIN_INTENT_TTL_MS = 5 * 60_000;
const SESSION_EXCHANGE_TTL_MS = 60_000;
const CARRIER_CREDENTIAL_TTL_MS = 60_000;

export type AuthServiceDependencies = Readonly<{
  repository: AuthRepository;
  passwordHasher: PasswordHasher;
  sessionHmacKey: Uint8Array;
  dummyPasswordHash: string;
  now?: () => Date;
  createId?: () => string;
  createSecret?: () => string;
}>;

export class AuthService {
  readonly #repository: AuthRepository;
  readonly #passwordHasher: PasswordHasher;
  readonly #sessionHmacKey: Uint8Array;
  readonly #dummyPasswordHash: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #createSecret: () => string;

  constructor(dependencies: AuthServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#passwordHasher = dependencies.passwordHasher;
    this.#sessionHmacKey = dependencies.sessionHmacKey;
    this.#dummyPasswordHash = dependencies.dummyPasswordHash;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? (() => randomBytes(16).toString("hex"));
    this.#createSecret = dependencies.createSecret ?? (() => randomBytes(24).toString("base64url"));
  }

  async bootstrapAdministrator(input: Readonly<{ username: string; displayName: string }>) {
    const result = await this.#buildAccount({
      username: input.username,
      displayName: input.displayName,
      roles: ["ADMIN"],
    });
    if (!await this.#repository.createFirstAccount(result.account)) {
      throw new AuthError("BOOTSTRAP_CLOSED", "최초 관리자 생성은 계정이 없을 때만 가능합니다.");
    }
    await this.#audit("ACCOUNT_BOOTSTRAPPED", undefined, result.account.id);
    return result;
  }

  async authenticate(input: Readonly<{
    username: string;
    password: string;
    remoteAddress: string;
  }>): Promise<Readonly<{ principal: Principal; sessionToken: string }>> {
    let username: string;
    try {
      username = normalizeUsername(input.username);
    } catch {
      username = input.username.trim().toLowerCase().slice(0, 64);
    }
    const now = this.#now();
    const account = await this.#repository.findAccountByUsername(username);
    const throttleKeys = account === undefined
      ? [this.#throttleKey("remote", input.remoteAddress)]
      : [this.#throttleKey("account", username)];
    const storedThrottles = await Promise.all(
      throttleKeys.map((key) => this.#repository.getLoginThrottle(key)),
    );
    const throttles = storedThrottles.map((throttle) =>
      throttle !== undefined && throttle.updatedAt.getTime() > now.getTime() - LOGIN_FAILURE_WINDOW_MS
        ? throttle
        : undefined);
    if (throttles.some((throttle) =>
      throttle?.lockedUntil !== undefined && throttle.lockedUntil.getTime() > now.getTime())) {
      throw new AuthError("LOGIN_THROTTLED", "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.");
    }

    const passwordMatches = await this.#passwordHasher.verify(
      account?.passwordHash ?? this.#dummyPasswordHash,
      input.password,
    );
    if (account === undefined || !account.enabled || !passwordMatches) {
      await Promise.all(throttleKeys.map(async (key, index) => {
        const failures = (throttles[index]?.failures ?? 0) + 1;
        await this.#repository.saveLoginThrottle({
          key,
          failures,
          ...(failures >= LOGIN_LOCK_THRESHOLD
            ? { lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MS) }
            : {}),
          updatedAt: now,
        });
      }));
      await this.#audit("LOGIN_FAILED", undefined, account?.id, { username });
      throw new AuthError("INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다.");
    }

    await Promise.all(throttleKeys.map((key) => this.#repository.deleteLoginThrottle(key)));
    const issued = await this.#issueSession(account, now);
    await this.#audit("LOGIN_SUCCEEDED", account.id, account.id);
    return issued;
  }

  async createLoginIntent(targetHost: string, targetPath: string): Promise<string> {
    if (targetHost.length < 1 || targetHost.length > 253 || !targetPath.startsWith("/") || targetPath.length > 4096) {
      throw new AuthError("INVALID_ACCOUNT_INPUT", "올바르지 않은 로그인 복귀 대상입니다.");
    }
    const id = this.#createSecret();
    await this.#repository.saveLoginIntent({
      id,
      targetHost,
      targetPath,
      expiresAt: new Date(this.#now().getTime() + LOGIN_INTENT_TTL_MS),
    });
    return id;
  }

  async createSessionExchange(
    principal: Principal,
    intentId: string,
  ): Promise<Readonly<{ code: string; targetHost: string; targetPath: string }>> {
    const account = await this.#requireCurrentAccount(principal);
    if (!account.roles.includes("REVIEWER")) {
      throw new AuthError("FORBIDDEN", "검토자 권한이 필요합니다.");
    }
    const intent = await this.#repository.consumeLoginIntent(intentId, this.#now());
    if (intent === undefined) throw new AuthError("FORBIDDEN", "로그인 요청이 만료됐거나 이미 사용됐습니다.");
    const code = this.#createSecret();
    await this.#repository.saveSessionExchange({
      codeDigest: this.#digestSessionToken(`exchange:${code}`),
      accountId: account.id,
      targetHost: intent.targetHost,
      targetPath: intent.targetPath,
      expiresAt: new Date(this.#now().getTime() + SESSION_EXCHANGE_TTL_MS),
    });
    return { code, targetHost: intent.targetHost, targetPath: intent.targetPath };
  }

  async consumeSessionExchange(
    code: string,
    targetHost: string,
  ): Promise<Readonly<{ principal: Principal; sessionToken: string; targetPath: string }>> {
    const exchange = await this.#repository.consumeSessionExchange(
      this.#digestSessionToken(`exchange:${code}`),
      targetHost,
      this.#now(),
    );
    if (exchange === undefined) throw new AuthError("FORBIDDEN", "세션 교환 코드가 올바르지 않습니다.");
    const account = await this.#requireAccount(exchange.accountId);
    if (!account.enabled || account.mustChangePassword || !account.roles.includes("REVIEWER")) {
      throw new AuthError("FORBIDDEN", "검토자 권한이 필요합니다.");
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
    await this.#repository.saveCarrierCredential({
      id,
      secretDigest: this.#digestSessionToken(`carrier:${id}:${secret}`),
      accountId: account.id,
      accountAuthVersion: account.authVersion,
      purpose: input.purpose,
      tunnelId: input.tunnelId,
      expiresAt: new Date(this.#now().getTime() + CARRIER_CREDENTIAL_TTL_MS),
    });
    return `${id}.${secret}`;
  }

  async consumeCarrierCredential(token: string): Promise<DeveloperAuthorization> {
    const separator = token.indexOf(".");
    if (separator < 1 || token.length > 512) throw new AuthError("FORBIDDEN", "Carrier 인증에 실패했습니다.");
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const credential = await this.#repository.consumeCarrierCredential(
      id,
      this.#digestSessionToken(`carrier:${id}:${secret}`),
      this.#now(),
    );
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
    const account = await this.#repository.findAccountById(accountId);
    return account !== undefined && account.enabled && !account.mustChangePassword &&
      account.authVersion === accountAuthVersion && account.roles.includes(role);
  }

  async cleanupExpiredArtifacts(): Promise<void> {
    await this.#repository.deleteExpiredAuthArtifacts(this.#now());
  }

  async checkHealth(): Promise<void> {
    await this.#repository.checkHealth();
  }

  async resolveSession(
    sessionToken: string,
    expectedAudience = "control",
  ): Promise<Principal | undefined> {
    if (sessionToken.length < 20 || sessionToken.length > 512) return undefined;
    const session = await this.#repository.findSessionByTokenDigest(
      this.#digestSessionToken(sessionToken),
    );
    if (session === undefined) return undefined;
    if (session.audience !== expectedAudience) return undefined;
    const account = await this.#repository.findAccountById(session.accountId);
    if (
      account === undefined ||
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
    if (!await this.#passwordHasher.verify(account.passwordHash, input.currentPassword)) {
      throw new AuthError("INVALID_CREDENTIALS", "현재 비밀번호가 올바르지 않습니다.");
    }
    validatePassword(input.newPassword);
    const updated = await this.#replacePassword(account, input.newPassword, false);
    await this.#audit("PASSWORD_CHANGED", account.id, account.id);
    await this.#repository.deleteSessionsForAccount(updated.id);
  }

  async createAccount(
    actor: Principal,
    input: Readonly<{ username: string; displayName: string; roles: readonly AccountRole[] }>,
  ) {
    await this.#requireAdministrator(actor);
    const result = await this.#createAccount(input);
    await this.#audit("ACCOUNT_CREATED", actor.accountId, result.account.id);
    return result;
  }

  async listAccounts(actor: Principal): Promise<readonly Account[]> {
    await this.#requireAdministrator(actor);
    return this.#repository.listAccounts();
  }

  async setAccountEnabled(actor: Principal, accountId: string, enabled: boolean): Promise<Account> {
    await this.#requireAdministrator(actor);
    const account = await this.#requireAccount(accountId);
    if (!enabled && account.enabled && account.roles.includes("ADMIN") &&
      await this.#repository.countEnabledAdministrators() <= 1) {
      throw new AuthError("LAST_ADMINISTRATOR", "마지막 활성 관리자는 비활성화할 수 없습니다.");
    }
    const updated: Account = {
      ...account,
      enabled,
      authVersion: account.authVersion + 1,
      updatedAt: this.#now(),
    };
    await this.#repository.saveAccount(updated);
    await this.#repository.deleteSessionsForAccount(accountId);
    await this.#audit(enabled ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED", actor.accountId, accountId);
    return updated;
  }

  async setAccountRoles(
    actor: Principal,
    accountId: string,
    roles: readonly AccountRole[],
  ): Promise<Account> {
    await this.#requireAdministrator(actor);
    const account = await this.#requireAccount(accountId);
    const normalizedRoles = normalizeRoles(roles);
    if (account.enabled && account.roles.includes("ADMIN") && !normalizedRoles.includes("ADMIN") &&
      await this.#repository.countEnabledAdministrators() <= 1) {
      throw new AuthError("LAST_ADMINISTRATOR", "마지막 활성 관리자의 관리자 권한은 제거할 수 없습니다.");
    }
    const updated: Account = {
      ...account,
      roles: normalizedRoles,
      authVersion: account.authVersion + 1,
      updatedAt: this.#now(),
    };
    await this.#repository.saveAccount(updated);
    await this.#repository.deleteSessionsForAccount(accountId);
    await this.#audit("ACCOUNT_ROLES_CHANGED", actor.accountId, accountId);
    return updated;
  }

  async resetPassword(actor: Principal, accountId: string) {
    await this.#requireAdministrator(actor);
    const account = await this.#requireAccount(accountId);
    const temporaryPassword = this.#createSecret();
    const updated = await this.#replacePassword(account, temporaryPassword, true);
    await this.#repository.deleteSessionsForAccount(accountId);
    await this.#audit("PASSWORD_RESET", actor.accountId, accountId);
    return { account: updated, temporaryPassword };
  }

  async revokeSessions(actor: Principal, accountId: string): Promise<void> {
    await this.#requireAdministrator(actor);
    await this.#requireAccount(accountId);
    await this.#repository.deleteSessionsForAccount(accountId);
    await this.#audit("SESSIONS_REVOKED", actor.accountId, accountId);
  }

  async #createAccount(input: Readonly<{
    username: string;
    displayName: string;
    roles: readonly AccountRole[];
  }>) {
    const result = await this.#buildAccount(input);
    try {
      await this.#repository.saveAccount(result.account);
    } catch (error) {
      if (error instanceof Error && error.message.includes("username")) {
        throw new AuthError("ACCOUNT_EXISTS", "이미 사용 중인 아이디입니다.");
      }
      throw error;
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

  async #replacePassword(account: Account, password: string, mustChangePassword: boolean) {
    const updated: Account = {
      ...account,
      passwordHash: await this.#passwordHasher.hash(password),
      mustChangePassword,
      authVersion: account.authVersion + 1,
      updatedAt: this.#now(),
    };
    await this.#repository.saveAccount(updated);
    return updated;
  }

  async #issueSession(account: Account, now: Date, audience = "control") {
    const sessionId = this.#createId();
    const sessionToken = `${sessionId}.${this.#createSecret()}`;
    await this.#repository.saveSession({
      id: sessionId,
      tokenDigest: this.#digestSessionToken(sessionToken),
      accountId: account.id,
      accountAuthVersion: account.authVersion,
      audience,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    });
    return { principal: toPrincipal(account, sessionId), sessionToken };
  }

  async #requireAdministrator(principal: Principal): Promise<Account> {
    const account = await this.#requireCurrentAccount(principal);
    if (!account.roles.includes("ADMIN")) {
      throw new AuthError("FORBIDDEN", "관리자 권한이 필요합니다.");
    }
    return account;
  }

  async #requireCurrentAccount(principal: Principal): Promise<Account> {
    const account = await this.#requireEnabledAccount(principal);
    if (account.mustChangePassword) {
      throw new AuthError("PASSWORD_CHANGE_REQUIRED", "먼저 임시 비밀번호를 변경해야 합니다.");
    }
    return account;
  }

  async #requireEnabledAccount(principal: Principal): Promise<Account> {
    const account = await this.#repository.findAccountById(principal.accountId);
    if (account === undefined || !account.enabled) {
      throw new AuthError("FORBIDDEN", "활성 계정이 아닙니다.");
    }
    return account;
  }

  async #requireAccount(accountId: string): Promise<Account> {
    const account = await this.#repository.findAccountById(accountId);
    if (account === undefined) throw new AuthError("ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다.");
    return account;
  }

  #digestSessionToken(token: string): string {
    return createHmac("sha256", this.#sessionHmacKey).update(token).digest("base64url");
  }

  #throttleKey(scope: "account" | "remote", value: string): string {
    return createHmac("sha256", this.#sessionHmacKey)
      .update(`${scope}\0${value}`)
      .digest("base64url");
  }

  async #audit(
    action: AuditAction,
    actorAccountId?: string,
    targetAccountId?: string,
    metadata: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<void> {
    await this.#repository.appendAuditEvent({
      id: this.#createId(),
      action,
      ...(actorAccountId === undefined ? {} : { actorAccountId }),
      ...(targetAccountId === undefined ? {} : { targetAccountId }),
      occurredAt: this.#now(),
      metadata,
    });
  }
}

function normalizeRoles(roles: readonly AccountRole[]): readonly AccountRole[] {
  const unique = [...new Set(roles)];
  if (unique.length === 0 || unique.some((role) => !ACCOUNT_ROLES.includes(role))) {
    throw new AuthError("INVALID_ACCOUNT_INPUT", "하나 이상의 올바른 권한이 필요합니다.");
  }
  return ACCOUNT_ROLES.filter((role) => unique.includes(role));
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
