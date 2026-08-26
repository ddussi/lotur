import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";

import {
  AuthError,
  AuthService,
  InMemoryAuthRepository,
  type PasswordHasher,
  type Principal,
} from "../../../packages/auth/src/index.ts";
import { createGatewayServer } from "./server.ts";

class TestHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

const DISCARD_AUTHENTICATION_EVENTS = { write() {}, reportFailure() {} };

function createAuthService(
  repository: InMemoryAuthRepository = new InMemoryAuthRepository(),
): AuthService {
  return new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 23),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
}

async function preparePasswordReadyAdministrator(authService: AuthService): Promise<string> {
  const bootstrap = await authService.bootstrapAdministrator({
    username: "administrator",
    displayName: "Administrator",
  });
  const temporaryLogin = await authService.authenticate({
    username: "administrator",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  const password = "administrator-password-2026";
  await authService.changeOwnPassword(temporaryLogin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: password,
  });
  return password;
}

test("web auth has one end-to-end deadline and retains admission until stalled work settles", async () => {
  const authService = createAuthService();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseLookup!: () => void;
  const heldLookup = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const originalResolveSession = authService.resolveSession.bind(authService);
  authService.resolveSession = async (token, audience) => {
    if (token === "held-cookie") {
      markStarted();
      await heldLookup;
      return undefined;
    }
    return originalResolveSession(token, audience);
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationQueryTimeoutMs: 30,
    maxConcurrentWebAuthorizations: 1,
    maxConcurrentWebAuthorizationsPerRemote: 1,
  });
  const port = await gateway.listen();

  try {
    const first = send(port, "control.localhost", "/account", {
      cookie: "rt_control_dev=held-cookie",
    });
    await started;
    assert.equal((await first).status, 503);

    const stillBounded = await send(port, "control.localhost", "/account", {
      cookie: "rt_control_dev=second-cookie",
    });
    assert.equal(stillBounded.status, 429);
    assert.equal(stillBounded.headers["retry-after"], "1");

    releaseLookup();
    await delay(10);
    assert.equal((await send(port, "control.localhost", "/account", {
      cookie: "rt_control_dev=released-cookie",
    })).status, 303);
  } finally {
    releaseLookup();
    await gateway.close();
  }
});

test("the authorization deadline is not reset between sequential database steps", async () => {
  const authService = createAuthService();
  const administrator: Principal = {
    accountId: "administrator-id",
    username: "administrator",
    displayName: "Administrator",
    roles: ["ADMIN"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId: "session-id",
  };
  let markFirstReadStarted!: () => void;
  const firstReadStarted = new Promise<void>((resolve) => {
    markFirstReadStarted = resolve;
  });
  let releaseFirstRead!: () => void;
  const heldFirstRead = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  let markSecondReadStarted!: () => void;
  const secondReadStarted = new Promise<void>((resolve) => {
    markSecondReadStarted = resolve;
  });
  let releaseSecondRead!: () => void;
  const heldSecondRead = new Promise<void>((resolve) => {
    releaseSecondRead = resolve;
  });
  authService.resolveSession = async () => {
    markFirstReadStarted();
    await heldFirstRead;
    return administrator;
  };
  authService.listAccounts = async () => {
    markSecondReadStarted();
    await heldSecondRead;
    return [];
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationQueryTimeoutMs: 100,
    maxConcurrentWebAuthorizations: 1,
    maxConcurrentWebAuthorizationsPerRemote: 1,
  });
  const port = await gateway.listen();

  try {
    const checkedAt = Date.now();
    const responsePromise = send(port, "control.localhost", "/admin/users", {
      cookie: "rt_control_dev=administrator-session",
    });
    await firstReadStarted;
    await delay(75);
    releaseFirstRead();
    await secondReadStarted;
    const response = await responsePromise;
    const elapsed = Date.now() - checkedAt;
    assert.equal(response.status, 503);
    assert.ok(elapsed >= 75, `deadline fired too soon after ${elapsed}ms`);
    assert.ok(elapsed < 150, `deadline appears to have reset between steps (${elapsed}ms)`);

    assert.equal((await send(port, "control.localhost", "/account", {
      cookie: "rt_control_dev=competing-session",
    })).status, 429);
  } finally {
    releaseFirstRead();
    releaseSecondRead();
    await delay(5);
    await gateway.close();
  }
});

test("an authorized business mutation is not raced by the authentication deadline", async () => {
  const authService = createAuthService();
  const administrator: Principal = {
    accountId: "administrator-id",
    username: "administrator",
    displayName: "Administrator",
    roles: ["ADMIN"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId: "session-id",
  };
  authService.resolveSession = async () => administrator;
  authService.verifyAdministratorCredentials = async () => ({
    accountId: administrator.accountId,
    authVersion: administrator.authVersion,
  });
  let markMutationStarted!: () => void;
  const mutationStarted = new Promise<void>((resolve) => {
    markMutationStarted = resolve;
  });
  let releaseMutation!: () => void;
  const heldMutation = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationQueryTimeoutMs: 25,
    async persistKillSwitch() {
      markMutationStarted();
      await heldMutation;
    },
  });
  const port = await gateway.listen();

  try {
    let responseSettled = false;
    const responsePromise = send(
      port,
      "control.localhost",
      "/admin/operations/kill-switch",
      {
        cookie: "rt_control_dev=administrator-session",
        origin: "http://control.localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      new URLSearchParams({ enabled: "true", adminPassword: "password" }).toString(),
      "POST",
    );
    void responsePromise.then(() => {
      responseSettled = true;
    });
    await mutationStarted;
    await delay(50);
    assert.equal(responseSettled, false, "business mutation received a premature timeout response");
    releaseMutation();
    assert.equal((await responsePromise).status, 200);
    assert.equal(gateway.isKillSwitchEnabled(), true);
  } finally {
    releaseMutation();
    await gateway.close();
  }
});

test("one-time authentication mutations keep admission but are not raced after commit starts", async () => {
  const authService = createAuthService();
  const reviewer: Principal = {
    accountId: "reviewer-id",
    username: "reviewer",
    displayName: "Reviewer",
    roles: ["REVIEWER"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId: "content-session-id",
  };
  let markConsumeStarted!: () => void;
  const consumeStarted = new Promise<void>((resolve) => {
    markConsumeStarted = resolve;
  });
  let releaseConsume!: () => void;
  const heldConsume = new Promise<void>((resolve) => {
    releaseConsume = resolve;
  });
  authService.consumeSessionExchange = async () => {
    markConsumeStarted();
    await heldConsume;
    return {
      principal: reviewer,
      sessionToken: "s".repeat(32),
      targetPath: "/review",
    };
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationQueryTimeoutMs: 25,
    maxConcurrentWebAuthorizations: 1,
    maxConcurrentWebAuthorizationsPerRemote: 1,
  });
  const port = await gateway.listen();

  try {
    let responseSettled = false;
    const responsePromise = send(
      port,
      "preview.localhost",
      "/_review-tunnel/session?code=one-time-code",
      {},
    );
    void responsePromise.then(() => {
      responseSettled = true;
    });
    await consumeStarted;
    await delay(50);
    assert.equal(responseSettled, false, "one-time exchange received a premature 503");

    const bounded = await send(
      port,
      "preview.localhost",
      "/_review-tunnel/session?code=second-code",
      {},
    );
    assert.equal(bounded.status, 429);

    releaseConsume();
    const consumed = await responsePromise;
    assert.equal(consumed.status, 303);
    assert.equal(consumed.headers.location, "/review");
  } finally {
    releaseConsume();
    await gateway.close();
  }
});

test("reviewer upgrades share the same deadline and retained admission boundary", async () => {
  const authService = createAuthService();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseLookup!: () => void;
  const heldLookup = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  authService.resolveSession = async () => {
    markStarted();
    await heldLookup;
    return undefined;
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationQueryTimeoutMs: 30,
    maxConcurrentWebAuthorizations: 1,
    maxConcurrentWebAuthorizationsPerRemote: 1,
  });
  const port = await gateway.listen();
  const first = reviewerSocket(port, "held-cookie");
  const firstStatus = unexpectedResponseStatus(first);
  let second: WebSocket | undefined;

  try {
    await started;
    assert.equal(await firstStatus, 503);
    second = reviewerSocket(port, "second-cookie");
    assert.equal(await unexpectedResponseStatus(second), 429);
  } finally {
    releaseLookup();
    first.terminate();
    second?.terminate();
    await delay(5);
    await gateway.close();
  }
});

test("logout mutation keeps operation admission until the underlying call settles", async () => {
  const authService = createAuthService();
  const administrator: Principal = {
    accountId: "administrator-id",
    username: "administrator",
    displayName: "Administrator",
    roles: ["ADMIN"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId: "administrator-session",
  };
  authService.resolveSession = async () => administrator;
  let logoutCalls = 0;
  let markLogoutStarted!: () => void;
  const logoutStarted = new Promise<void>((resolve) => {
    markLogoutStarted = resolve;
  });
  let releaseLogout!: () => void;
  const heldLogout = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  authService.logout = async () => {
    logoutCalls += 1;
    markLogoutStarted();
    await heldLogout;
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationQueryTimeoutMs: 25,
    maxConcurrentWebAuthorizations: 1,
    maxConcurrentWebAuthorizationsPerRemote: 1,
  });
  const port = await gateway.listen();
  const headers = {
    cookie: "rt_control_dev=administrator-session",
    origin: "http://control.localhost",
  };

  try {
    let firstSettled = false;
    const first = send(port, "control.localhost", "/logout", headers, undefined, "POST");
    void first.then(() => {
      firstSettled = true;
    });
    await logoutStarted;
    await delay(50);
    assert.equal(firstSettled, false, "logout mutation was raced by the query deadline");

    const second = await send(
      port,
      "control.localhost",
      "/logout",
      headers,
      undefined,
      "POST",
    );
    assert.equal(second.status, 429);
    assert.equal(logoutCalls, 1);

    releaseLogout();
    assert.equal((await first).status, 303);
  } finally {
    releaseLogout();
    await gateway.close();
  }
});

test("admin list query retains admission after its response deadline", async () => {
  const authService = createAuthService();
  const administrator: Principal = {
    accountId: "administrator-id",
    username: "administrator",
    displayName: "Administrator",
    roles: ["ADMIN"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId: "administrator-session",
  };
  authService.resolveSession = async () => administrator;
  let listCalls = 0;
  let markListStarted!: () => void;
  const listStarted = new Promise<void>((resolve) => {
    markListStarted = resolve;
  });
  let releaseList!: () => void;
  const heldList = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  authService.listAccounts = async () => {
    listCalls += 1;
    markListStarted();
    await heldList;
    return [];
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationQueryTimeoutMs: 25,
    maxConcurrentWebAuthorizations: 1,
    maxConcurrentWebAuthorizationsPerRemote: 1,
  });
  const port = await gateway.listen();
  const headers = { cookie: "rt_control_dev=administrator-session" };

  try {
    const first = send(port, "control.localhost", "/admin/users", headers);
    await listStarted;
    assert.equal((await first).status, 503);

    const second = await send(port, "control.localhost", "/admin/users", headers);
    assert.equal(second.status, 429);
    assert.equal(listCalls, 1);
  } finally {
    releaseList();
    await delay(5);
    await gateway.close();
  }
});

test("one-time temporary passwords are returned without a fallible follow-up list", async () => {
  const authService = createAuthService();
  const administrator: Principal = {
    accountId: "administrator-id",
    username: "administrator",
    displayName: "Administrator",
    roles: ["ADMIN"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId: "administrator-session",
  };
  const targetAccount = {
    id: "target-id",
    username: "target-user",
    displayName: "Target User",
    roles: ["REVIEWER"] as const,
    passwordHash: "hashed:temporary",
    enabled: true,
    mustChangePassword: true,
    authVersion: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  authService.resolveSession = async () => administrator;
  authService.verifyAdministratorCredentials = async () => ({
    accountId: administrator.accountId,
    authVersion: administrator.authVersion,
  });
  authService.createAccount = async () => ({
    account: { ...targetAccount, id: "created-id", username: "created-user" },
    temporaryPassword: "create<&password",
  });
  authService.resetPassword = async () => ({
    account: targetAccount,
    temporaryPassword: "reset<&password",
  });
  let mode: "CREATE" | "RESET" = "CREATE";
  let resetListCalls = 0;
  authService.listAccounts = async () => {
    if (mode === "CREATE") throw new Error("unexpected post-create list failure");
    resetListCalls += 1;
    if (resetListCalls > 1) throw new Error("post-reset list failure");
    return [targetAccount];
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
  });
  const port = await gateway.listen();
  const headers = {
    cookie: "rt_control_dev=administrator-session",
    origin: "http://control.localhost",
    "content-type": "application/x-www-form-urlencoded",
  };

  try {
    const created = await send(
      port,
      "control.localhost",
      "/admin/users",
      headers,
      new URLSearchParams({
        username: "created-user",
        displayName: "Created User",
        roles: "REVIEWER",
        adminPassword: "password",
      }).toString(),
      "POST",
    );
    assert.equal(created.status, 201);
    assert.match(created.body, /create&lt;&amp;password/);
    assert.doesNotMatch(created.body, /create<&password/);

    mode = "RESET";
    const reset = await send(
      port,
      "control.localhost",
      `/admin/users/${targetAccount.id}/reset`,
      headers,
      new URLSearchParams({ adminPassword: "password" }).toString(),
      "POST",
    );
    assert.equal(reset.status, 200);
    assert.match(reset.body, /reset&lt;&amp;password/);
    assert.doesNotMatch(reset.body, /reset<&password/);
    assert.equal(resetListCalls, 1);
  } finally {
    await gateway.close();
  }
});

test("failed login exchange creation compensates the undisclosed session before releasing admission", async () => {
  const repository = new InMemoryAuthRepository();
  const authService = createAuthService(repository);
  const password = await preparePasswordReadyAdministrator(authService);
  const baselineSessions = repository.sessions.size;
  authService.createSessionExchange = async () => {
    throw new AuthError("FORBIDDEN", "exchange rejected");
  };
  const realLogout = authService.logout.bind(authService);
  let markCleanupStarted!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  let releaseCleanup!: () => void;
  const heldCleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  authService.logout = async (principal) => {
    markCleanupStarted();
    await heldCleanup;
    await realLogout(principal);
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    maxConcurrentWebAuthorizations: 1,
    maxConcurrentWebAuthorizationsPerRemote: 1,
  });
  const port = await gateway.listen();
  const loginForm = new URLSearchParams({
    username: "administrator",
    password,
    intent: "rejected-intent",
  }).toString();

  try {
    const rejectedLogin = send(
      port,
      "control.localhost",
      "/login",
      {
        origin: "http://control.localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      loginForm,
      "POST",
    );
    await Promise.race([
      cleanupStarted,
      delay(250).then(() => {
        throw new Error("compensating logout was not started");
      }),
    ]);
    assert.equal(repository.sessions.size, baselineSessions + 1);

    const competingLogin = await send(
      port,
      "control.localhost",
      "/login",
      {
        origin: "http://control.localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      loginForm,
      "POST",
    );
    assert.equal(competingLogin.status, 429);

    releaseCleanup();
    assert.equal((await rejectedLogin).status, 403);
    assert.equal(repository.sessions.size, baselineSessions);
  } finally {
    releaseCleanup();
    await gateway.close();
  }
});

test("failed password-change exchange creation compensates its replacement session", async () => {
  const repository = new InMemoryAuthRepository();
  const authService = createAuthService(repository);
  const password = await preparePasswordReadyAdministrator(authService);
  const currentLogin = await authService.authenticate({
    username: "administrator",
    password,
    remoteAddress: "127.0.0.1",
  });
  const baselineSessions = repository.sessions.size;
  authService.createSessionExchange = async () => {
    throw new AuthError("FORBIDDEN", "exchange rejected");
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
  });
  const port = await gateway.listen();

  try {
    const response = await send(
      port,
      "control.localhost",
      "/account/change-password",
      {
        origin: "http://control.localhost",
        cookie: `rt_control_dev=${encodeURIComponent(currentLogin.sessionToken)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      new URLSearchParams({
        currentPassword: password,
        newPassword: "administrator-password-2027",
        confirmation: "administrator-password-2027",
        intent: "rejected-intent",
      }).toString(),
      "POST",
    );
    assert.equal(response.status, 403);
    assert.ok(repository.sessions.size < baselineSessions);
    assert.equal(response.headers["set-cookie"], undefined);
  } finally {
    await gateway.close();
  }
});

test("trusted proxy identity is shared by login and administrator reauthentication", async () => {
  const authService = createAuthService();
  const observed: string[] = [];
  authService.authenticate = async (input) => {
    observed.push(`login:${input.remoteAddress}`);
    throw new AuthError("INVALID_CREDENTIALS", "invalid credentials");
  };
  const administrator: Principal = {
    accountId: "administrator-id",
    username: "administrator",
    displayName: "Administrator",
    roles: ["ADMIN"],
    mustChangePassword: false,
    authVersion: 4,
    sessionId: "session-id",
  };
  authService.resolveSession = async () => administrator;
  authService.verifyAdministratorCredentials = async (input) => {
    observed.push(`admin:${input.remoteAddress}`);
    return { accountId: administrator.accountId, authVersion: administrator.authVersion };
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    trustedProxyCidrs: ["127.0.0.0/8"],
  });
  const port = await gateway.listen();

  try {
    const forwardedFor = "198.51.100.250, 203.0.113.7";
    const login = await send(port, "control.localhost", "/api/client/login", {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": forwardedFor,
      "x-review-tunnel-client": "1",
    }, new URLSearchParams({ username: "user", password: "password" }).toString(), "POST");
    assert.equal(login.status, 400);

    const reauthenticated = await send(
      port,
      "control.localhost",
      "/admin/operations/kill-switch",
      {
        cookie: "rt_control_dev=administrator-session",
        origin: "http://control.localhost",
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": forwardedFor,
      },
      new URLSearchParams({ enabled: "false", adminPassword: "password" }).toString(),
      "POST",
    );
    assert.equal(reauthenticated.status, 200);
    assert.deepEqual(observed, ["login:203.0.113.7", "admin:203.0.113.7"]);
  } finally {
    await gateway.close();
  }
});

test("current-password checks share the bounded credential-attempt admission", async () => {
  const authService = createAuthService();
  const principal: Principal = {
    accountId: "account-id",
    username: "developer",
    displayName: "Developer",
    roles: ["DEVELOPER"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId: "session-id",
  };
  authService.resolveSession = async () => principal;
  authService.authenticate = async () => ({
    principal,
    sessionToken: "replacement-session-token",
  });
  let changeCalls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseChange!: () => void;
  const heldChange = new Promise<void>((resolve) => {
    releaseChange = resolve;
  });
  authService.changeOwnPassword = async () => {
    changeCalls += 1;
    if (changeCalls === 1) {
      markStarted();
      await heldChange;
    }
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    maxConcurrentLoginAttempts: 1,
    maxConcurrentLoginAttemptsPerRemote: 1,
  });
  const port = await gateway.listen();
  const submitChange = () => send(
    port,
    "control.localhost",
    "/account/change-password",
    {
      origin: "http://control.localhost",
      cookie: "rt_control_dev=session-token",
      "content-type": "application/x-www-form-urlencoded",
    },
    new URLSearchParams({
      currentPassword: "current-password",
      newPassword: "replacement-password-2026",
      confirmation: "replacement-password-2026",
    }).toString(),
    "POST",
  );

  const first = submitChange();
  try {
    await started;
    const second = await submitChange();
    assert.equal(second.status, 429);
    assert.equal(changeCalls, 1);
    releaseChange();
    assert.equal((await first).status, 303);
  } finally {
    releaseChange();
    await first.catch(() => undefined);
    await gateway.close();
  }
});

test("login-intent limiting uses the same trusted client boundary", async () => {
  const authService = createAuthService();
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    trustedProxyCidrs: ["127.0.0.0/8"],
    loginIntentsPerSourcePerMinute: 1,
    loginIntentsGlobalPerMinute: 10,
  });
  const port = await gateway.listen();

  try {
    const first = await send(port, "preview.localhost", "/review", {
      accept: "text/html",
      "x-forwarded-for": "198.51.100.1",
    });
    const secondClient = await send(port, "preview.localhost", "/review", {
      accept: "text/html",
      "x-forwarded-for": "198.51.100.2",
    });
    const repeatedClient = await send(port, "preview.localhost", "/review", {
      accept: "text/html",
      "x-forwarded-for": "198.51.100.1",
    });
    assert.equal(first.status, 303);
    assert.equal(secondClient.status, 303);
    assert.equal(repeatedClient.status, 429);
  } finally {
    await gateway.close();
  }
});

test("content authentication rejects authorities outside the configured share domain", async () => {
  const authService = createAuthService();
  let intentCreates = 0;
  let exchangeConsumes = 0;
  let sessionResolutions = 0;
  const createLoginIntent = authService.createLoginIntent.bind(authService);
  const consumeSessionExchange = authService.consumeSessionExchange.bind(authService);
  authService.createLoginIntent = async (...arguments_) => {
    intentCreates += 1;
    return createLoginIntent(...arguments_);
  };
  authService.consumeSessionExchange = async (...arguments_) => {
    exchangeConsumes += 1;
    return consumeSessionExchange(...arguments_);
  };
  authService.resolveSession = async () => {
    sessionResolutions += 1;
    return undefined;
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "preview.example.com",
    controlHost: "control.example.com",
    authService,
    secureCookies: false,
  });
  const port = await gateway.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
    headers: { host: "attacker.example.net" },
  });
  const socketStatus = unexpectedResponseStatus(socket);

  try {
    const browser = await send(port, "attacker.example.net", "/review", {
      accept: "text/html",
    });
    assert.equal(browser.status, 404);
    assert.equal(browser.headers.location, undefined);

    const malformedAuthority = await send(
      port,
      "preview.preview.example.com:invalid",
      "/review",
      { accept: "text/html" },
    );
    assert.equal(malformedAuthority.status, 404);
    assert.equal(malformedAuthority.headers.location, undefined);

    const exchange = await send(
      port,
      "attacker.example.net",
      "/_review-tunnel/session?code=untrusted-host-code",
      {},
    );
    assert.equal(exchange.status, 404);
    assert.equal(await socketStatus, 404);
    assert.deepEqual({ intentCreates, exchangeConsumes, sessionResolutions }, {
      intentCreates: 0,
      exchangeConsumes: 0,
      sessionResolutions: 0,
    });
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

test("content authentication creates login intents only for top-level GET navigation", async () => {
  const authService = createAuthService();
  let intentCreates = 0;
  const createLoginIntent = authService.createLoginIntent.bind(authService);
  authService.createLoginIntent = async (...arguments_) => {
    intentCreates += 1;
    return createLoginIntent(...arguments_);
  };
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
  });
  const port = await gateway.listen();

  try {
    const getNavigation = await send(
      port,
      "preview.localhost",
      "/review",
      { accept: "text/html" },
    );
    assert.equal(getNavigation.status, 303);

    const headNavigation = await send(
      port,
      "preview.localhost",
      "/review",
      { accept: "text/html" },
      undefined,
      "HEAD",
    );
    assert.equal(headNavigation.status, 401);

    const fetch = await send(port, "preview.localhost", "/fragment", {
      accept: "text/html",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
    });
    assert.equal(fetch.status, 401);

    const iframe = await send(port, "preview.localhost", "/embedded", {
      accept: "text/html",
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
    });
    assert.equal(iframe.status, 401);
    assert.equal(intentCreates, 1);
  } finally {
    await gateway.close();
  }
});

test("one-domain deployment rejects control mutations from a sibling preview origin", async () => {
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "preview.example.com",
    controlHost: "control.example.com",
    authService: createAuthService(),
    secureCookies: false,
  });
  const port = await gateway.listen();

  try {
    const response = await send(
      port,
      "control.example.com",
      "/login",
      {
        origin: "http://attacker.preview.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      new URLSearchParams({ username: "user", password: "password" }).toString(),
      "POST",
    );
    assert.equal(response.status, 403);
  } finally {
    await gateway.close();
  }
});

async function send(
  port: number,
  host: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body?: string,
  method: "GET" | "HEAD" | "POST" = "GET",
): Promise<Readonly<{
  status: number;
  body: string;
  headers: import("node:http").IncomingHttpHeaders;
}>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { host, ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function reviewerSocket(port: number, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/socket`, {
    headers: {
      host: "preview.localhost",
      cookie: `rt_session_dev=${token}`,
    },
  });
}

function unexpectedResponseStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => reject(new Error("WebSocket upgrade was unexpectedly accepted")));
    socket.once("error", () => undefined);
  });
}
