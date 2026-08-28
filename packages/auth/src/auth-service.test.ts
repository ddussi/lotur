import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AuthError,
  AuthService,
  AuditEventCapacityError,
  InMemoryAuthRepository,
  type AuthenticationEvent,
  type PasswordHasher,
} from "./index.ts";

class TestHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

class SessionLookupCountingRepository extends InMemoryAuthRepository {
  readonly lookupBatchSizes: number[] = [];

  async findSessionAccountByTokenDigests(tokenDigests: readonly string[]) {
    this.lookupBatchSizes.push(tokenDigests.length);
    return super.findSessionAccountByTokenDigests(tokenDigests);
  }
}

class AuthorizationBatchCountingRepository extends InMemoryAuthRepository {
  readonly authorizationBatchSizes: number[] = [];

  async findAccountsByIds(accountIds: readonly string[]) {
    this.authorizationBatchSizes.push(accountIds.length);
    return super.findAccountsByIds(accountIds);
  }
}

const DISCARD_AUTHENTICATION_EVENTS = Object.freeze({
  write() {},
  reportFailure() {},
});

function fixture() {
  let sequence = 0;
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const repository = new InMemoryAuthRepository();
  const authenticationEvents: AuthenticationEvent[] = [];
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    now: () => new Date(now),
    createId: () => `id-${++sequence}`,
    createSecret: () => `temporary-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: {
      write(event) {
        authenticationEvents.push(event);
      },
      reportFailure() {},
    },
  });
  return {
    authenticationEvents,
    repository,
    service,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

test("bootstrap creates exactly one administrator with a one-time password", async () => {
  const { service } = fixture();

  const created = await service.bootstrapAdministrator({
    username: " Root.Admin ",
    displayName: "운영 관리자",
  });

  assert.equal(created.account.username, "root.admin");
  assert.deepEqual(created.account.roles, ["ADMIN"]);
  assert.equal(created.account.mustChangePassword, true);
  assert.match(created.temporaryPassword, /^[A-Za-z0-9_-]{20,}$/);
  await assert.rejects(
    service.bootstrapAdministrator({ username: "second", displayName: "Second" }),
    (error: unknown) => error instanceof AuthError && error.code === "BOOTSTRAP_CLOSED",
  );
});

test("administrator creates a disabled-by-default-safe account and receives password once", async () => {
  const { service } = fixture();
  const administrator = await service.bootstrapAdministrator({
    username: "admin",
    displayName: "Admin",
  });
  const login = await service.authenticate({
    username: "admin",
    password: administrator.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(login.principal, {
    currentPassword: administrator.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const changedLogin = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });

  const created = await service.createAccount(changedLogin.principal, {
    username: "Developer_1",
    displayName: "개발자 1",
    roles: ["DEVELOPER", "REVIEWER"],
  });

  assert.equal(created.account.username, "developer_1");
  assert.deepEqual(created.account.roles, ["DEVELOPER", "REVIEWER"]);
  assert.equal(created.account.mustChangePassword, true);
  assert.notEqual(created.temporaryPassword, administrator.temporaryPassword);
});

test("first login can only become a normal session after changing the temporary password", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({
    username: "admin",
    displayName: "Admin",
  });

  const temporaryLogin = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  assert.equal(temporaryLogin.principal.mustChangePassword, true);

  await service.changeOwnPassword(temporaryLogin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "a-long-and-unique-password-2026",
  });
  await assert.rejects(
    service.authenticate({
      username: "admin",
      password: bootstrap.temporaryPassword,
      remoteAddress: "127.0.0.1",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS",
  );
  const login = await service.authenticate({
    username: "admin",
    password: "a-long-and-unique-password-2026",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(login.principal.mustChangePassword, false);
});

test("administrator command authentication verifies credentials without creating a session", async () => {
  const { service, repository, authenticationEvents } = fixture();
  const bootstrap = await service.bootstrapAdministrator({
    username: "admin",
    displayName: "Admin",
  });
  const temporaryLogin = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "local-admin-cli",
  });
  await service.changeOwnPassword(temporaryLogin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-command-password-2026",
  });
  const sessionsBefore = repository.sessions.size;
  const auditsBefore = repository.auditEvents.length;
  const authenticationEventsBefore = authenticationEvents.length;

  const authorization = await service.verifyAdministratorCredentials({
    username: "admin",
    password: "administrator-command-password-2026",
    remoteAddress: "local-admin-cli",
  });

  assert.equal(authorization.accountId, bootstrap.account.id);
  assert.equal(authorization.authVersion, 2);
  assert.equal(repository.sessions.size, sessionsBefore);
  assert.equal(repository.auditEvents.length, auditsBefore);
  assert.deepEqual(
    authenticationEvents.slice(authenticationEventsBefore).map((event) => event.action),
    ["LOGIN_SUCCEEDED"],
  );
});

test("malformed usernames cannot alias a valid 64-character account", async () => {
  const { service, repository } = fixture();
  const canonicalUsername = "a".repeat(64);
  const bootstrap = await service.bootstrapAdministrator({
    username: canonicalUsername,
    displayName: "Boundary User",
  });

  await assert.rejects(
    service.authenticate({
      username: `${canonicalUsername}!`,
      password: bootstrap.temporaryPassword,
      remoteAddress: "198.51.100.64",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS",
  );
  assert.equal(repository.sessions.size, 0);
});

test("account writes revalidate a command actor at the repository transaction boundary", async () => {
  class RevokingRepository extends InMemoryAuthRepository {
    revokeActorBeforeCreate = false;

    override async createAccount(
      input: Parameters<InMemoryAuthRepository["createAccount"]>[0],
    ) {
      if (this.revokeActorBeforeCreate) {
        this.revokeActorBeforeCreate = false;
        const actor = this.accounts.get(input.authorization.accountId);
        if (actor !== undefined) {
          this.accounts.set(actor.id, { ...actor, authVersion: actor.authVersion + 1 });
        }
      }
      return super.createAccount(input);
    }
  }
  let sequence = 0;
  const repository = new RevokingRepository();
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    createId: () => `actor-race-${++sequence}`,
    createSecret: () => `actor-race-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "local-admin-cli",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-command-password-2026",
  });
  const actor = await service.verifyAdministratorCredentials({
    username: "admin",
    password: "administrator-command-password-2026",
    remoteAddress: "local-admin-cli",
  });
  const accountsBefore = repository.accounts.size;
  const auditsBefore = repository.auditEvents.length;
  repository.revokeActorBeforeCreate = true;

  await assert.rejects(
    service.createAccount(actor, {
      username: "must-not-exist",
      displayName: "Must Not Exist",
      roles: ["REVIEWER"],
    }),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
  assert.equal(repository.accounts.size, accountsBefore);
  assert.equal(repository.auditEvents.length, auditsBefore);
});

test("generic storage failures mentioning username are not misclassified as duplicate accounts", async () => {
  class FailingCreateRepository extends InMemoryAuthRepository {
    failCreate = false;

    override async createAccount(
      input: Parameters<InMemoryAuthRepository["createAccount"]>[0],
    ) {
      if (this.failCreate) throw new Error("username lookup backend failed");
      return super.createAccount(input);
    }
  }
  const repository = new FailingCreateRepository();
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 17),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: { write() {}, reportFailure() {} },
  });
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "local-test",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "local-test",
  });
  repository.failCreate = true;

  await assert.rejects(
    service.createAccount(administrator.principal, {
      username: "new-user",
      displayName: "New User",
      roles: ["REVIEWER"],
    }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof AuthError) &&
      error.message === "username lookup backend failed",
  );
});

test("durable administrative audit cap fails mutations closed without consuming the operational reserve", async () => {
  const repository = new InMemoryAuthRepository({
    auditEventLimits: { global: 3, operationalReserve: 1 },
  });
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 18),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: { write() {}, reportFailure() {} },
  });
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "local-test",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "local-test",
  });
  const before = await repository.findAccountById(administrator.principal.accountId);

  await assert.rejects(
    service.changeOwnPassword(administrator.principal, {
      currentPassword: "administrator-password-2026",
      newPassword: "administrator-password-2027",
    }),
    AuditEventCapacityError,
  );
  assert.equal(repository.auditEvents.length, 2);
  assert.deepEqual(await repository.findAccountById(administrator.principal.accountId), before);
});

test("stored authentication sessions are bounded per account and globally", async () => {
  let sequence = 0;
  const repository = new InMemoryAuthRepository();
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    createId: () => `session-cap-${++sequence}`,
    createSecret: () => `session-cap-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
    authArtifactLimits: {
      sessions: { global: 1, perAccount: 1 },
      sessionExchanges: { global: 8, perAccount: 8 },
      carrierCredentials: { global: 8, perAccount: 8 },
    },
  });
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "192.0.2.1",
  });

  await assert.rejects(
    service.authenticate({
      username: "admin",
      password: bootstrap.temporaryPassword,
      remoteAddress: "192.0.2.2",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "AUTH_CAPACITY",
  );
  assert.equal(repository.sessions.size, 1);
});

test("one-time session exchanges and Carrier credentials have independent capacities", async () => {
  let sequence = 0;
  const repository = new InMemoryAuthRepository();
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    createId: () => `artifact-cap-${++sequence}`,
    createSecret: () => `artifact-cap-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
    authArtifactLimits: {
      sessions: { global: 16, perAccount: 16 },
      sessionExchanges: { global: 1, perAccount: 1 },
      carrierCredentials: { global: 1, perAccount: 1 },
    },
  });
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "192.0.2.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-artifact-password-2026",
  });
  let administrator = await service.authenticate({
    username: "admin",
    password: "administrator-artifact-password-2026",
    remoteAddress: "192.0.2.1",
  });
  await service.setAccountRoles(
    administrator.principal,
    administrator.principal.accountId,
    ["ADMIN", "DEVELOPER", "REVIEWER"],
  );
  administrator = await service.authenticate({
    username: "admin",
    password: "administrator-artifact-password-2026",
    remoteAddress: "192.0.2.1",
  });

  await service.issueCarrierCredential(administrator.principal, {
    purpose: "create",
    tunnelId: "first-capacity-tunnel",
  });
  await assert.rejects(
    service.issueCarrierCredential(administrator.principal, {
      purpose: "create",
      tunnelId: "second-capacity-tunnel",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "AUTH_CAPACITY",
  );

  const firstIntent = await service.createLoginIntent("one.preview.example", "/first");
  await service.createSessionExchange(administrator.principal, firstIntent);
  const secondIntent = await service.createLoginIntent("two.preview.example", "/second");
  await assert.rejects(
    service.createSessionExchange(administrator.principal, secondIntent),
    (error: unknown) => error instanceof AuthError && error.code === "AUTH_CAPACITY",
  );
  assert.equal(repository.carrierCredentials.size, 1);
  assert.equal(repository.sessionExchanges.size, 1);
});

test("expired artifact backlogs do not consume live capacities", async () => {
  const repository = new InMemoryAuthRepository();
  const now = new Date("2026-08-21T00:00:00.000Z");
  repository.accounts.set("backlog-account", {
    id: "backlog-account",
    username: "backlog-account",
    displayName: "Backlog Account",
    roles: ["ADMIN", "DEVELOPER", "REVIEWER"],
    passwordHash: "hashed:backlog-password",
    enabled: true,
    mustChangePassword: false,
    authVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  for (let index = 0; index < 501; index += 1) {
    const expiresAt = new Date(now.getTime() - 1);
    repository.sessions.set(`expired-session-${index}`, {
      id: `expired-session-${index}`,
      tokenDigest: `expired-session-digest-${index}`,
      accountId: "backlog-account",
      accountAuthVersion: 1,
      audience: "control",
      createdAt: expiresAt,
      lastSeenAt: expiresAt,
      expiresAt,
    });
    repository.sessionExchanges.set(`expired-exchange-${index}`, {
      codeDigest: `expired-exchange-${index}`,
      accountId: "backlog-account",
      accountAuthVersion: 1,
      targetHost: "backlog.preview.example",
      targetPath: "/",
      expiresAt,
    });
    repository.carrierCredentials.set(`expired-carrier-${index}`, {
      id: `expired-carrier-${index}`,
      secretDigest: `expired-carrier-digest-${index}`,
      accountId: "backlog-account",
      accountAuthVersion: 1,
      purpose: "create",
      tunnelId: `expired-tunnel-${index}`,
      expiresAt,
    });
  }
  const liveExpiry = new Date(now.getTime() + 60_000);
  const limits = { global: 1, perAccount: 1 } as const;

  assert.deepEqual(await Promise.all([
    repository.saveSession({
      id: "live-session",
      tokenDigest: "live-session-digest",
      accountId: "backlog-account",
      accountAuthVersion: 1,
      audience: "control",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: liveExpiry,
    }, now, limits),
    repository.saveSessionExchange({
      codeDigest: "live-exchange",
      accountId: "backlog-account",
      accountAuthVersion: 1,
      targetHost: "backlog.preview.example",
      targetPath: "/",
      expiresAt: liveExpiry,
    }, now, limits),
    repository.saveCarrierCredential({
      id: "live-carrier",
      secretDigest: "live-carrier-digest",
      accountId: "backlog-account",
      accountAuthVersion: 1,
      purpose: "create",
      tunnelId: "live-tunnel",
      expiresAt: liveExpiry,
    }, now, limits),
  ]), [true, true, true]);
  assert.equal(repository.sessions.size, 1);
  assert.equal(repository.sessionExchanges.size, 1);
  assert.equal(repository.carrierCredentials.size, 1);
});

test("five failed logins temporarily lock the account", async () => {
  const { service, advance } = fixture();
  const bootstrap = await service.bootstrapAdministrator({
    username: "admin",
    displayName: "Admin",
  });

  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      service.authenticate({
        username: "admin",
        password: "incorrect password",
        remoteAddress: "192.0.2.1",
      }),
      AuthError,
    );
  }
  await assert.rejects(
    service.authenticate({
      username: "admin",
      password: bootstrap.temporaryPassword,
      remoteAddress: "192.0.2.1",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "LOGIN_THROTTLED",
  );
  advance(30_001);
  const login = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "192.0.2.1",
  });
  assert.equal(login.principal.username, "admin");
});

test("failed current-password checks share the durable login throttle", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({
    username: "admin",
    displayName: "Admin",
  });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "192.0.2.10",
  });

  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      service.changeOwnPassword(temporary.principal, {
        currentPassword: "incorrect password",
        newPassword: "administrator-password-2026",
      }),
      (error: unknown) =>
        error instanceof AuthError && error.code === "INVALID_CREDENTIALS",
    );
  }

  await assert.rejects(
    service.changeOwnPassword(temporary.principal, {
      currentPassword: bootstrap.temporaryPassword,
      newPassword: "administrator-password-2026",
    }),
    (error: unknown) =>
      error instanceof AuthError && error.code === "LOGIN_THROTTLED",
  );
});

test("disabling an account invalidates all of its sessions", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({
    username: "admin",
    displayName: "Admin",
  });
  const adminLogin = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(adminLogin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const currentAdminLogin = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const created = await service.createAccount(currentAdminLogin.principal, {
    username: "reviewer",
    displayName: "Reviewer",
    roles: ["REVIEWER"],
  });
  const reviewerLogin = await service.authenticate({
    username: "reviewer",
    password: created.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  assert.equal((await service.resolveSession(reviewerLogin.sessionToken))?.username, "reviewer");

  await service.setAccountEnabled(currentAdminLogin.principal, created.account.id, false);

  assert.equal(await service.resolveSession(reviewerLogin.sessionToken), undefined);
  await assert.rejects(
    service.authenticate({
      username: "reviewer",
      password: created.temporaryPassword,
      remoteAddress: "127.0.0.1",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS",
  );
});

test("non-admin users cannot manage accounts", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const admin = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(admin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const currentAdmin = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const created = await service.createAccount(currentAdmin.principal, {
    username: "reviewer",
    displayName: "Reviewer",
    roles: ["REVIEWER"],
  });
  const reviewer = await service.authenticate({
    username: "reviewer",
    password: created.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(reviewer.principal, {
    currentPassword: created.temporaryPassword,
    newPassword: "reviewer-password-2026",
  });
  const currentReviewer = await service.authenticate({
    username: "reviewer",
    password: "reviewer-password-2026",
    remoteAddress: "127.0.0.1",
  });

  await assert.rejects(
    service.createAccount(currentReviewer.principal, {
      username: "intruder",
      displayName: "Intruder",
      roles: ["ADMIN"],
    }),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
});

test("password policy rejects short passwords and account events are audited", async () => {
  const { service, repository, authenticationEvents } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const login = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });

  await assert.rejects(
    service.changeOwnPassword(login.principal, {
      currentPassword: bootstrap.temporaryPassword,
      newPassword: "too-short",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "WEAK_PASSWORD",
  );
  assert.deepEqual(
    repository.auditEvents.map((event) => event.action),
    ["ACCOUNT_BOOTSTRAPPED"],
  );
  assert.deepEqual(
    authenticationEvents.map((event) => event.action),
    ["LOGIN_SUCCEEDED"],
  );
});

test("content-host session exchange is host-bound and one-time", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporaryAdmin = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporaryAdmin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const admin = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const created = await service.createAccount(admin.principal, {
    username: "reviewer",
    displayName: "Reviewer",
    roles: ["REVIEWER"],
  });
  const temporaryReviewer = await service.authenticate({
    username: "reviewer",
    password: created.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporaryReviewer.principal, {
    currentPassword: created.temporaryPassword,
    newPassword: "reviewer-password-2026",
  });
  const reviewer = await service.authenticate({
    username: "reviewer",
    password: "reviewer-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const intent = await service.createLoginIntent("abc.preview.example", "/screen?mode=review");
  const exchange = await service.createSessionExchange(reviewer.principal, intent);

  await assert.rejects(
    service.consumeSessionExchange(exchange.code, "other.preview.example"),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
  const contentSession = await service.consumeSessionExchange(
    exchange.code,
    "abc.preview.example",
  );
  assert.equal(contentSession.targetPath, "/screen?mode=review");
  assert.equal(contentSession.principal.username, "reviewer");
  assert.equal(await service.resolveSession(contentSession.sessionToken), undefined);
  assert.equal(
    (await service.resolveSession(
      contentSession.sessionToken,
      "content:abc.preview.example",
    ))?.username,
    "reviewer",
  );
  await assert.rejects(
    service.consumeSessionExchange(exchange.code, "abc.preview.example"),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
});

test("developers can obtain a content-host session for their review workflow", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({
    username: "developer",
    displayName: "Developer",
  });
  const temporary = await service.authenticate({
    username: "developer",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "developer-password-2026",
  });
  let developer = await service.authenticate({
    username: "developer",
    password: "developer-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await service.setAccountRoles(
    developer.principal,
    developer.principal.accountId,
    ["ADMIN", "DEVELOPER"],
  );
  developer = await service.authenticate({
    username: "developer",
    password: "developer-password-2026",
    remoteAddress: "127.0.0.1",
  });

  const intent = await service.createLoginIntent("dev.preview.example", "/review");
  const exchange = await service.createSessionExchange(developer.principal, intent);
  const content = await service.consumeSessionExchange(exchange.code, "dev.preview.example");
  assert.equal(content.principal.accountId, developer.principal.accountId);
  assert.equal(
    (await service.resolveSession(content.sessionToken, "content:dev.preview.example"))?.username,
    "developer",
  );
});

test("carrier credential is purpose-bound, short-lived state consumed only once", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const admin = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await service.setAccountRoles(admin.principal, admin.principal.accountId, ["ADMIN", "DEVELOPER"]);
  const developer = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const token = await service.issueCarrierCredential(developer.principal, {
    purpose: "create",
    tunnelId: "tunnel-1",
  });

  const authorization = await service.consumeCarrierCredential(token);
  assert.equal(authorization.purpose, "create");
  assert.equal(authorization.tunnelId, "tunnel-1");
  await assert.rejects(
    service.consumeCarrierCredential(token),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
});

test("last active administrator cannot be disabled or lose the ADMIN role", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });

  await assert.rejects(
    service.setAccountEnabled(administrator.principal, administrator.principal.accountId, false),
    (error: unknown) => error instanceof AuthError && error.code === "LAST_ADMINISTRATOR",
  );
  await assert.rejects(
    service.setAccountRoles(administrator.principal, administrator.principal.accountId, ["REVIEWER"]),
    (error: unknown) => error instanceof AuthError && error.code === "LAST_ADMINISTRATOR",
  );
});

test("administrator password reset revokes sessions and requires another first-login change", async () => {
  const { service } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporaryAdmin = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporaryAdmin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const created = await service.createAccount(administrator.principal, {
    username: "developer",
    displayName: "Developer",
    roles: ["DEVELOPER"],
  });
  const oldLogin = await service.authenticate({
    username: "developer",
    password: created.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });

  const reset = await service.resetPassword(administrator.principal, created.account.id);

  assert.equal(await service.resolveSession(oldLogin.sessionToken), undefined);
  const resetLogin = await service.authenticate({
    username: "developer",
    password: reset.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  assert.equal(resetLogin.principal.mustChangePassword, true);
});

test("expired Carrier credentials are rejected and cleaned up", async () => {
  const { service, repository, advance } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await service.setAccountRoles(
    administrator.principal,
    administrator.principal.accountId,
    ["ADMIN", "DEVELOPER"],
  );
  const developer = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const credential = await service.issueCarrierCredential(developer.principal, {
    purpose: "create",
    tunnelId: "expiring-tunnel",
  });
  advance(60_001);

  await assert.rejects(service.consumeCarrierCredential(credential), AuthError);
  await service.cleanupExpiredArtifacts();
  assert.equal(repository.carrierCredentials.size, 0);
});

test("HMAC key rotation은 이전 세션을 읽고 새 세션은 active key로만 발급한다", async () => {
  const repository = new SessionLookupCountingRepository();
  const oldKey = Buffer.alloc(32, 1);
  const newKey = Buffer.alloc(32, 2);
  const dependencies = {
    repository,
    passwordHasher: new TestHasher(),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  };
  const oldService = new AuthService({ ...dependencies, sessionHmacKey: oldKey });
  const bootstrap = await oldService.bootstrapAdministrator({
    username: "admin",
    displayName: "Admin",
  });
  const temporary = await oldService.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await oldService.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const oldLogin = await oldService.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });

  const rotatedService = new AuthService({
    ...dependencies,
    sessionHmacKey: newKey,
    previousSessionHmacKeys: [oldKey],
  });
  assert.equal((await rotatedService.resolveSession(oldLogin.sessionToken))?.username, "admin");
  const newLogin = await rotatedService.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  assert.equal((await rotatedService.resolveSession(newLogin.sessionToken))?.username, "admin");
  assert.equal(await oldService.resolveSession(newLogin.sessionToken), undefined);
  assert.deepEqual(repository.lookupBatchSizes, [2, 2, 1]);
});

test("session HMAC rotation keys are bounded and unique by key material", () => {
  const dependencies = {
    repository: new InMemoryAuthRepository(),
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 1),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  };

  assert.throws(
    () => new AuthService({
      ...dependencies,
      previousSessionHmacKeys: [
        Buffer.alloc(32, 2),
        Buffer.alloc(32, 3),
        Buffer.alloc(32, 4),
        Buffer.alloc(32, 5),
      ],
    }),
    /at most 3 previous session HMAC keys/,
  );
  assert.throws(
    () => new AuthService({
      ...dependencies,
      previousSessionHmacKeys: [Buffer.alloc(32, 1)],
    }),
    /session HMAC keys must be unique/,
  );
  assert.throws(
    () => new AuthService({
      ...dependencies,
      previousSessionHmacKeys: [Buffer.alloc(32, 2), Buffer.alloc(32, 2)],
    }),
    /session HMAC keys must be unique/,
  );
  assert.throws(
    () => new AuthService({
      ...dependencies,
      sessionHmacKey: Buffer.alloc(129, 1),
    }),
    /session HMAC keys must contain between 32 and 128 bytes/,
  );
  assert.throws(
    () => new AuthService({
      ...dependencies,
      previousSessionHmacKeys: [Buffer.alloc(129, 2)],
    }),
    /session HMAC keys must contain between 32 and 128 bytes/,
  );
});

test("account authorization checks deduplicate IDs and use bounded repository batches", async () => {
  const repository = new AuthorizationBatchCountingRepository();
  repository.accounts.set("known-account", {
    id: "known-account",
    username: "known",
    displayName: "Known",
    roles: ["DEVELOPER"],
    passwordHash: "hashed:irrelevant",
    enabled: true,
    mustChangePassword: false,
    authVersion: 7,
    createdAt: new Date("2026-08-21T00:00:00.000Z"),
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
  });
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  const checks = [
    { accountId: "known-account", accountAuthVersion: 7, role: "DEVELOPER" as const },
    { accountId: "known-account", accountAuthVersion: 6, role: "DEVELOPER" as const },
    { accountId: "known-account", accountAuthVersion: 7, role: "REVIEWER" as const },
    ...Array.from({ length: 1_024 }, (_, index) => ({
      accountId: `missing-${index}`,
      accountAuthVersion: 1,
      role: "REVIEWER" as const,
    })),
  ];

  const results = await service.areAccountsAuthorized(checks);

  assert.deepEqual(results.slice(0, 3), [true, false, false]);
  assert.equal(results.slice(3).every((authorized) => !authorized), true);
  assert.deepEqual(repository.authorizationBatchSizes.toSorted((a, b) => a - b), [1, 512, 512]);
});

test("revoking sessions advances authorization and removes sessions and unused Carrier credentials", async () => {
  const { service, repository } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await service.setAccountRoles(
    administrator.principal,
    administrator.principal.accountId,
    ["ADMIN", "DEVELOPER"],
  );
  const developer = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const credential = await service.issueCarrierCredential(developer.principal, {
    purpose: "create",
    tunnelId: "revoked-tunnel",
  });
  const before = await repository.findAccountById(developer.principal.accountId);

  await service.revokeSessions(developer.principal, developer.principal.accountId);

  const after = await repository.findAccountById(developer.principal.accountId);
  assert.equal(after?.authVersion, (before?.authVersion ?? 0) + 1);
  assert.equal(await service.resolveSession(developer.sessionToken), undefined);
  await assert.rejects(
    service.consumeCarrierCredential(credential),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
  assert.equal(repository.carrierCredentials.size, 0);
  assert.equal(repository.auditEvents.at(-1)?.action, "SESSIONS_REVOKED");
});

test("revocation rejects every stale account-owned authentication artifact", async () => {
  const { service, repository } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  let administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await service.setAccountRoles(
    administrator.principal,
    administrator.principal.accountId,
    ["ADMIN", "DEVELOPER", "REVIEWER"],
  );
  administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const staleVersion = administrator.principal.authVersion;
  const now = new Date("2026-08-21T00:00:00.000Z");

  await service.revokeSessions(administrator.principal, administrator.principal.accountId);

  const results = await Promise.all([
    repository.saveSession({
      id: "stale-session",
      tokenDigest: "stale-session-digest",
      accountId: administrator.principal.accountId,
      accountAuthVersion: staleVersion,
      audience: "control",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    }, now, { global: 8, perAccount: 8 }),
    repository.saveSessionExchange({
      codeDigest: "stale-exchange-digest",
      accountId: administrator.principal.accountId,
      accountAuthVersion: staleVersion,
      targetHost: "stale.preview.example",
      targetPath: "/",
      expiresAt: new Date(now.getTime() + 60_000),
    }, now, { global: 8, perAccount: 8 }),
    repository.saveCarrierCredential({
      id: "stale-carrier",
      secretDigest: "stale-carrier-digest",
      accountId: administrator.principal.accountId,
      accountAuthVersion: staleVersion,
      purpose: "create",
      tunnelId: "stale-tunnel",
      expiresAt: new Date(now.getTime() + 60_000),
    }, now, { global: 8, perAccount: 8 }),
  ]);

  assert.deepEqual(results, [false, false, false]);
  assert.equal(repository.sessions.size, 0);
  assert.equal(repository.sessionExchanges.size, 0);
  assert.equal(repository.carrierCredentials.size, 0);
});

test("artifact issuance reports stale authorization separately from capacity", async () => {
  class RevokingArtifactRepository extends InMemoryAuthRepository {
    revokeBeforeSessionSave = false;
    revokeBeforeCarrierSave = false;

    override async saveSession(
      ...arguments_: Parameters<InMemoryAuthRepository["saveSession"]>
    ): Promise<boolean> {
      if (this.revokeBeforeSessionSave) {
        this.revokeBeforeSessionSave = false;
        this.#advanceAccountVersion(arguments_[0].accountId);
      }
      return super.saveSession(...arguments_);
    }

    override async saveCarrierCredential(
      ...arguments_: Parameters<InMemoryAuthRepository["saveCarrierCredential"]>
    ): Promise<boolean> {
      if (this.revokeBeforeCarrierSave) {
        this.revokeBeforeCarrierSave = false;
        this.#advanceAccountVersion(arguments_[0].accountId);
      }
      return super.saveCarrierCredential(...arguments_);
    }

    #advanceAccountVersion(accountId: string): void {
      const account = this.accounts.get(accountId);
      assert.ok(account !== undefined);
      this.accounts.set(accountId, {
        ...account,
        authVersion: account.authVersion + 1,
      });
    }
  }

  const repository = new RevokingArtifactRepository();
  const now = new Date("2026-08-21T00:00:00.000Z");
  repository.accounts.set("artifact-race-account", {
    id: "artifact-race-account",
    username: "artifact-race-account",
    displayName: "Artifact Race Account",
    roles: ["DEVELOPER"],
    passwordHash: "hashed:artifact-race-password",
    enabled: true,
    mustChangePassword: false,
    authVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  let sequence = 0;
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    now: () => now,
    createId: () => `artifact-race-id-${++sequence}`,
    createSecret: () => `artifact-race-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  repository.revokeBeforeSessionSave = true;

  await assert.rejects(
    service.authenticate({
      username: "artifact-race-account",
      password: "artifact-race-password",
      remoteAddress: "198.51.100.80",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
  assert.equal(repository.sessions.size, 0);
  const current = await repository.findAccountById("artifact-race-account");
  assert.ok(current !== undefined);
  repository.revokeBeforeCarrierSave = true;

  await assert.rejects(
    service.issueCarrierCredential({
      accountId: current.id,
      username: current.username,
      displayName: current.displayName,
      roles: current.roles,
      mustChangePassword: current.mustChangePassword,
      authVersion: current.authVersion,
      sessionId: "artifact-race-session",
    }, {
      purpose: "create",
      tunnelId: "artifact-race-tunnel",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
  assert.equal(repository.carrierCredentials.size, 0);
});

test("a session exchange created under a revoked auth version cannot mint a new session", async () => {
  const { service, repository } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  let reviewer = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await service.setAccountRoles(
    reviewer.principal,
    reviewer.principal.accountId,
    ["ADMIN", "REVIEWER"],
  );
  reviewer = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const intent = await service.createLoginIntent("revoked.preview.example", "/review");
  const exchange = await service.createSessionExchange(reviewer.principal, intent);
  const storedExchange = [...repository.sessionExchanges.entries()][0];
  assert.ok(storedExchange !== undefined);

  await service.revokeSessions(reviewer.principal, reviewer.principal.accountId);
  repository.sessionExchanges.set(...storedExchange);

  await assert.rejects(
    service.consumeSessionExchange(exchange.code, "revoked.preview.example"),
    (error: unknown) => error instanceof AuthError && error.code === "FORBIDDEN",
  );
  assert.equal(repository.sessions.size, 0);
});

test("concurrent administrator removal preserves one enabled administrator", async () => {
  const { service, repository } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin-one", displayName: "Admin One" });
  const temporaryOne = await service.authenticate({
    username: "admin-one",
    password: bootstrap.temporaryPassword,
    remoteAddress: "192.0.2.1",
  });
  await service.changeOwnPassword(temporaryOne.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-one-password-2026",
  });
  const adminOne = await service.authenticate({
    username: "admin-one",
    password: "administrator-one-password-2026",
    remoteAddress: "192.0.2.1",
  });
  const created = await service.createAccount(adminOne.principal, {
    username: "admin-two",
    displayName: "Admin Two",
    roles: ["ADMIN"],
  });
  const temporaryTwo = await service.authenticate({
    username: "admin-two",
    password: created.temporaryPassword,
    remoteAddress: "192.0.2.2",
  });
  await service.changeOwnPassword(temporaryTwo.principal, {
    currentPassword: created.temporaryPassword,
    newPassword: "administrator-two-password-2026",
  });
  const adminTwo = await service.authenticate({
    username: "admin-two",
    password: "administrator-two-password-2026",
    remoteAddress: "192.0.2.2",
  });

  const results = await Promise.allSettled([
    service.setAccountEnabled(adminOne.principal, adminTwo.principal.accountId, false),
    service.setAccountEnabled(adminTwo.principal, adminOne.principal.accountId, false),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await repository.countEnabledAdministrators(), 1);
});

test("a delayed password reset cannot restore roles changed while hashing", async () => {
  let releaseHash: (() => void) | undefined;
  let resetHashStarted: (() => void) | undefined;
  const resetHashGate = new Promise<void>((resolve) => {
    resetHashStarted = resolve;
  });
  const releaseResetHash = new Promise<void>((resolve) => {
    releaseHash = resolve;
  });
  class DelayedHasher extends TestHasher {
    delayNextHash = false;

    override async hash(password: string): Promise<string> {
      if (this.delayNextHash) {
        this.delayNextHash = false;
        resetHashStarted?.();
        await releaseResetHash;
      }
      return super.hash(password);
    }
  }
  let sequence = 0;
  const secrets = [
    "bootstrap-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "developer-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "reset-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ];
  const repository = new InMemoryAuthRepository();
  const passwordHasher = new DelayedHasher();
  const service = new AuthService({
    repository,
    passwordHasher,
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
    createId: () => `delayed-id-${++sequence}`,
    createSecret: () => secrets.shift() ?? `fallback-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
  });
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporary = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await service.changeOwnPassword(temporary.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  const administrator = await service.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const developer = await service.createAccount(administrator.principal, {
    username: "developer",
    displayName: "Developer",
    roles: ["DEVELOPER"],
  });

  passwordHasher.delayNextHash = true;
  const reset = service.resetPassword(administrator.principal, developer.account.id);
  await resetHashGate;
  await service.setAccountRoles(administrator.principal, developer.account.id, ["REVIEWER"]);
  releaseHash?.();
  await assert.rejects(
    reset,
    (error: unknown) => error instanceof AuthError && error.code === "ACCOUNT_CONFLICT",
  );

  assert.deepEqual((await repository.findAccountById(developer.account.id))?.roles, ["REVIEWER"]);
});

test("parallel failed logins are atomically counted for the same identity and remote", async () => {
  const { service, repository } = fixture();
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });

  await Promise.allSettled(Array.from({ length: 20 }, () => service.authenticate({
    username: "admin",
    password: `${bootstrap.temporaryPassword}-wrong`,
    remoteAddress: "198.51.100.8",
  })));

  assert.equal(repository.loginThrottles.size, 2);
  assert.deepEqual(
    [...repository.loginThrottles.values()].map((throttle) => throttle.failures),
    [20, 20],
  );
  assert.ok([...repository.loginThrottles.values()].every((throttle) => throttle.lockedUntil !== undefined));
});

test("login throttle storage has a hard cap, updates existing keys at capacity, and reclaims the real window", async () => {
  const repository = new InMemoryAuthRepository();
  const startedAt = new Date("2026-08-24T00:00:00.000Z");
  const first = await repository.recordLoginFailure({
    keys: ["identity-a", "remote-a"],
    now: startedAt,
    windowStartsAt: new Date(startedAt.getTime() - 15 * 60_000),
    lockThreshold: 5,
    lockedUntil: new Date(startedAt.getTime() + 30_000),
    limits: { global: 2 },
  });
  assert.equal(first.status, "RECORDED");
  assert.equal(repository.loginThrottles.size, 2);

  const atCapacity = await repository.recordLoginFailure({
    keys: ["identity-a", "remote-b"],
    now: new Date(startedAt.getTime() + 1),
    windowStartsAt: new Date(startedAt.getTime() - 15 * 60_000 + 1),
    lockThreshold: 5,
    lockedUntil: new Date(startedAt.getTime() + 30_001),
    limits: { global: 2 },
  });
  assert.equal(atCapacity.status, "CAPACITY_EXHAUSTED");
  assert.equal((await repository.getLoginThrottle("identity-a"))?.failures, 2);
  assert.equal(await repository.getLoginThrottle("remote-b"), undefined);
  assert.equal(repository.loginThrottles.size, 2);

  const reclaimedAt = new Date(startedAt.getTime() + 15 * 60_000 + 1);
  const reclaimed = await repository.recordLoginFailure({
    keys: ["identity-c", "remote-c"],
    now: reclaimedAt,
    windowStartsAt: new Date(reclaimedAt.getTime() - 15 * 60_000),
    lockThreshold: 5,
    lockedUntil: new Date(reclaimedAt.getTime() + 30_000),
    limits: { global: 2 },
  });
  assert.equal(reclaimed.status, "RECORDED");
  assert.deepEqual([...repository.loginThrottles.keys()].sort(), ["identity-c", "remote-c"]);
});

test("login throttle capacity is typed fail-closed and high-volume events bypass durable audit", async () => {
  const repository = new InMemoryAuthRepository();
  const authenticationEvents: AuthenticationEvent[] = [];
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 9),
    dummyPasswordHash: "hashed:not-the-password",
    loginThrottleLimits: { global: 2 },
    authenticationEventSink: {
      write(event) {
        authenticationEvents.push(event);
      },
      reportFailure() {},
    },
  });

  await assert.rejects(
    service.authenticate({
      username: "missing-a",
      password: "incorrect-password",
      remoteAddress: "198.51.100.1",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS",
  );
  await assert.rejects(
    service.authenticate({
      username: "missing-b",
      password: "incorrect-password",
      remoteAddress: "198.51.100.1",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "AUTH_CAPACITY",
  );

  assert.equal(repository.loginThrottles.size, 2);
  assert.deepEqual(
    [...repository.loginThrottles.values()].map((throttle) => throttle.failures).sort(),
    [1, 2],
  );
  assert.equal(repository.auditEvents.length, 0);
  assert.deepEqual(
    authenticationEvents.map((event) => [event.action, event.reason]),
    [
      ["LOGIN_FAILED", "INVALID_CREDENTIALS"],
      ["LOGIN_FAILED", "THROTTLE_CAPACITY"],
    ],
  );
  for (const event of authenticationEvents) {
    assert.match(event.identityRef, /^[A-Za-z0-9_-]{43}$/);
    assert.match(event.remoteRef, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(event.identityRef, "missing-a");
    assert.notEqual(event.remoteRef, "198.51.100.1");
    assert.equal("password" in event, false);
  }
});

test("authentication telemetry sink failures are reported without changing committed auth state", async () => {
  const repository = new InMemoryAuthRepository();
  let sinkFailures = 0;
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 10),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: {
      write() {
        throw new Error("telemetry unavailable");
      },
      reportFailure() {
        sinkFailures += 1;
      },
    },
  });
  const bootstrap = await service.bootstrapAdministrator({ username: "admin", displayName: "Admin" });

  const login = await service.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "198.51.100.9",
  });
  assert.equal(repository.sessions.has(login.principal.sessionId), true);
  assert.equal(sinkFailures, 1);

  await assert.rejects(
    service.authenticate({
      username: "missing-user",
      password: "incorrect-password",
      remoteAddress: "198.51.100.9",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS",
  );
  assert.equal(repository.loginThrottles.size, 2);
  assert.equal(sinkFailures, 2);
});

test("existing and missing usernames have the same cross-remote throttle behavior", async () => {
  async function throttleCode(username: string): Promise<string | undefined> {
    const { service } = fixture();
    await service.bootstrapAdministrator({ username: "known-user", displayName: "Known User" });
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(service.authenticate({
        username,
        password: "incorrect-password",
        remoteAddress: "203.0.113.1",
      }));
    }
    try {
      await service.authenticate({
        username,
        password: "incorrect-password",
        remoteAddress: "203.0.113.2",
      });
    } catch (error) {
      return error instanceof AuthError ? error.code : undefined;
    }
    return undefined;
  }

  assert.equal(await throttleCode("known-user"), "LOGIN_THROTTLED");
  assert.equal(await throttleCode("missing-user"), "LOGIN_THROTTLED");
});

test("login intents are bounded per host and globally while expired intents free capacity", async () => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const repository = new InMemoryAuthRepository();
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    now: () => new Date(now),
    createId: () => "unused-id",
    createSecret: (() => {
      let sequence = 0;
      return () => `intent-secret-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
    })(),
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
    loginIntentLimits: { global: 3, perHost: 2 },
  });

  await service.createLoginIntent("one.preview.example", "/first");
  await service.createLoginIntent("one.preview.example", "/second");
  await assert.rejects(
    service.createLoginIntent("one.preview.example", "/third"),
    (error: unknown) => error instanceof AuthError && error.code === "LOGIN_INTENT_CAPACITY",
  );
  await service.createLoginIntent("two.preview.example", "/third");
  await assert.rejects(
    service.createLoginIntent("two.preview.example", "/fourth"),
    (error: unknown) => error instanceof AuthError && error.code === "LOGIN_INTENT_CAPACITY",
  );

  now += 5 * 60_000 + 1;
  await service.createLoginIntent("two.preview.example", "/after-expiry");
  assert.equal(repository.loginIntents.size, 1);
});
