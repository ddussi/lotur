import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AuthError,
  AuthService,
  InMemoryAuthRepository,
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

function fixture() {
  let sequence = 0;
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const repository = new InMemoryAuthRepository();
  const service = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    now: () => new Date(now),
    createId: () => `id-${++sequence}`,
    createSecret: () => `temporary-${++sequence}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:not-the-password",
  });
  return {
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
  const { service, repository } = fixture();
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
    ["ACCOUNT_BOOTSTRAPPED", "LOGIN_SUCCEEDED"],
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
