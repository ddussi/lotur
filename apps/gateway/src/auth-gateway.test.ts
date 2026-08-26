import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import {
  AuthService,
  InMemoryAuthRepository,
  type AccountAuthorization,
  type PasswordHasher,
} from "../../../packages/auth/src/index.ts";
import { connectTunnelClient } from "../../client/src/client.ts";
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

test("administrator-issued accounts gate HTTP, admin UI and Carrier, then revoke an active Tunnel", async () => {
  const repository = new InMemoryAuthRepository();
  const authService = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 3),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
    loginIntentLimits: { global: 1, perHost: 1 },
  });
  const bootstrap = await authService.bootstrapAdministrator({ username: "admin", displayName: "Admin" });
  const temporaryAdmin = await authService.authenticate({
    username: "admin",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await authService.changeOwnPassword(temporaryAdmin.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "administrator-password-2026",
  });
  let administrator = await authService.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await authService.setAccountRoles(
    administrator.principal,
    administrator.principal.accountId,
    ["ADMIN", "DEVELOPER"],
  );
  administrator = await authService.authenticate({
    username: "admin",
    password: "administrator-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const reviewerAccount = await authService.createAccount(administrator.principal, {
    username: "reviewer",
    displayName: "Reviewer",
    roles: ["REVIEWER"],
  });
  const temporaryReviewer = await authService.authenticate({
    username: "reviewer",
    password: reviewerAccount.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await authService.changeOwnPassword(temporaryReviewer.principal, {
    currentPassword: reviewerAccount.temporaryPassword,
    newPassword: "reviewer-password-2026",
  });
  const reviewer = await authService.authenticate({
    username: "reviewer",
    password: "reviewer-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const loggedOutAccountIds: string[] = [];
  const realLogout = authService.logout.bind(authService);
  authService.logout = async (principal) => {
    loggedOutAccountIds.push(principal.accountId);
    await realLogout(principal);
  };
  const realAuthenticate = authService.authenticate.bind(authService);
  let heldLoginStarted!: () => void;
  const heldLoginStartedPromise = new Promise<void>((resolve) => {
    heldLoginStarted = resolve;
  });
  let releaseHeldLogin!: () => void;
  const heldLoginRelease = new Promise<void>((resolve) => {
    releaseHeldLogin = resolve;
  });
  authService.authenticate = async (input) => {
    if (input.password === "hold-login-attempt") {
      heldLoginStarted();
      await heldLoginRelease;
    }
    return realAuthenticate(input);
  };
  const realCreateLoginIntent = authService.createLoginIntent.bind(authService);
  let loginIntentCreateCalls = 0;
  authService.createLoginIntent = async (...arguments_) => {
    loginIntentCreateCalls += 1;
    return realCreateLoginIntent(...arguments_);
  };
  const realVerifyAdministratorCredentials =
    authService.verifyAdministratorCredentials.bind(authService);
  let lastConfirmedAuthorization: AccountAuthorization | undefined;
  authService.verifyAdministratorCredentials = async (input) => {
    const authorization = await realVerifyAdministratorCredentials(input);
    lastConfirmedAuthorization = authorization;
    return authorization;
  };
  const realCreateAccount = authService.createAccount.bind(authService);
  let createAccountActor: AccountAuthorization | undefined;
  authService.createAccount = async (actor, input) => {
    createAccountActor = actor;
    return realCreateAccount(actor, input);
  };
  const realAuthorizationCheck = authService.isAccountAuthorized.bind(authService);
  const realAuthorizationBatch = authService.areAccountsAuthorized.bind(authService);
  let authorizationDatabaseAvailable = true;
  let authorizationOutageChecks = 0;
  authService.isAccountAuthorized = async (...arguments_) => {
    if (!authorizationDatabaseAvailable) {
      authorizationOutageChecks += 1;
      return new Promise<boolean>(() => undefined);
    }
    return realAuthorizationCheck(...arguments_);
  };
  authService.areAccountsAuthorized = async (checks) => {
    if (!authorizationDatabaseAvailable) {
      authorizationOutageChecks += 1;
      return new Promise<readonly boolean[]>(() => undefined);
    }
    return realAuthorizationBatch(checks);
  };
  const gatewayEvents: string[] = [];

  const origin = createServer((incoming, response) => {
    assert.equal(incoming.headers.cookie, "app_session=visible-to-app");
    response.setHeader("Set-Cookie", [
      "rt_session_dev=overwrite-attempt; Path=/",
      "app_session=updated; Path=/",
    ]);
    response.end("private preview");
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originAddress = origin.address();
  assert.ok(originAddress !== null && typeof originAddress !== "string");
  const persistedKillSwitchValues: boolean[] = [];
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 5,
    authorizationQueryTimeoutMs: 35,
    maxTunnelsPerAccount: 2,
    loginIntentsPerSourcePerMinute: 2,
    maxConcurrentLoginAttempts: 1,
    maxConcurrentLoginAttemptsPerRemote: 1,
    maxOutstandingCarrierCredentialsPerAccount: 2,
    carrierCredentialsPerAccountPerMinute: 5,
    async persistKillSwitch(enabled, actor) {
      assert.strictEqual(actor, lastConfirmedAuthorization);
      assert.equal(actor.accountId, administrator.principal.accountId);
      assert.equal(actor.authVersion, administrator.principal.authVersion);
      await delay(5);
      persistedKillSwitchValues.push(enabled);
    },
    logger(event) {
      gatewayEvents.push(event.event);
    },
  });
  const gatewayPort = await gateway.listen();
  const heldLogin = send(gatewayPort, "control.localhost", "/api/client/login", {
    method: "POST",
    headers: {
      "x-review-tunnel-client": "1",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: "admin",
      password: "hold-login-attempt",
    }).toString(),
  });
  await heldLoginStartedPromise;
  const boundedAdministratorConfirmation = await send(
    gatewayPort,
    "control.localhost",
    "/admin/operations/kill-switch",
    {
      method: "POST",
      headers: {
        origin: "http://control.localhost",
        cookie: `rt_control_dev=${encodeURIComponent(administrator.sessionToken)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        enabled: "true",
        adminPassword: "administrator-password-2026",
      }).toString(),
    },
  );
  assert.equal(boundedAdministratorConfirmation.status, 429);
  assert.equal(gateway.isKillSwitchEnabled(), false);
  const boundedLogin = await send(gatewayPort, "control.localhost", "/api/client/login", {
    method: "POST",
    headers: {
      "x-review-tunnel-client": "1",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: "does-not-exist",
      password: "another-attempt",
    }).toString(),
  });
  assert.equal(boundedLogin.status, 429);
  releaseHeldLogin();
  assert.equal((await heldLogin).status, 400);
  const clientLoginResponse = await send(gatewayPort, "control.localhost", "/api/client/login", {
    method: "POST",
    headers: {
      "x-review-tunnel-client": "1",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: "admin",
      password: "administrator-password-2026",
    }).toString(),
  });
  assert.equal(clientLoginResponse.status, 200);
  const clientLogin = JSON.parse(clientLoginResponse.body) as { sessionToken?: string };
  assert.equal(typeof clientLogin.sessionToken, "string");
  const disposableLoginResponse = await send(
    gatewayPort,
    "control.localhost",
    "/api/client/login",
    {
      method: "POST",
      headers: {
        "x-review-tunnel-client": "1",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: "admin",
        password: "administrator-password-2026",
      }).toString(),
    },
  );
  assert.equal(disposableLoginResponse.status, 200);
  const disposableLogin = JSON.parse(disposableLoginResponse.body) as {
    sessionToken?: string;
  };
  assert.equal(typeof disposableLogin.sessionToken, "string");
  const cliLogout = await send(
    gatewayPort,
    "control.localhost",
    "/api/client/logout",
    {
      method: "POST",
      headers: {
        "x-review-tunnel-client": "1",
        authorization: `Bearer ${disposableLogin.sessionToken}`,
      },
    },
  );
  assert.equal(cliLogout.status, 204);
  const rejectedAfterLogout = await send(
    gatewayPort,
    "control.localhost",
    "/api/carrier-credentials",
    {
      method: "POST",
      headers: {
        "x-review-tunnel-client": "1",
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${disposableLogin.sessionToken}`,
      },
      body: new URLSearchParams({ purpose: "create" }).toString(),
    },
  );
  assert.equal(rejectedAfterLogout.status, 403);
  const credentialResponse = await send(
    gatewayPort,
    "control.localhost",
    "/api/carrier-credentials",
    {
      method: "POST",
      headers: {
        "x-review-tunnel-client": "1",
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${clientLogin.sessionToken}`,
      },
      body: new URLSearchParams({ purpose: "create", tunnelId: "secured-tunnel" }).toString(),
    },
  );
  assert.equal(credentialResponse.status, 201);
  const issued = JSON.parse(credentialResponse.body) as {
    credential?: string;
    tunnelId?: string;
  };
  if (issued.credential === undefined || issued.tunnelId === undefined) {
    throw new Error("Carrier credential was not issued");
  }
  assert.match(issued.tunnelId, /^[a-f0-9]{32}$/);
  const securedHost = `${issued.tunnelId}.localhost`;
  const client = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: issued.tunnelId,
    localOrigin: `http://127.0.0.1:${originAddress.port}`,
    carrierCredential: issued.credential,
  });
  let secondClient: ReturnType<typeof connectTunnelClient> | undefined;

  try {
    await client.ready;
    const secondCredentialResponse = await send(
      gatewayPort,
      "control.localhost",
      "/api/carrier-credentials",
      {
        method: "POST",
        headers: {
          "x-review-tunnel-client": "1",
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${clientLogin.sessionToken}`,
        },
        body: new URLSearchParams({ purpose: "create" }).toString(),
      },
    );
    assert.equal(secondCredentialResponse.status, 201);
    const secondIssued = JSON.parse(secondCredentialResponse.body) as {
      credential?: string;
      tunnelId?: string;
    };
    assert.ok(secondIssued.credential !== undefined && secondIssued.tunnelId !== undefined);
    secondClient = connectTunnelClient({
      gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId: secondIssued.tunnelId,
      localOrigin: `http://127.0.0.1:${originAddress.port}`,
      carrierCredential: secondIssued.credential,
    });
    await secondClient.ready;
    for (let index = 0; index < 2; index += 1) {
      const resumeCredential = await send(
        gatewayPort,
        "control.localhost",
        "/api/carrier-credentials",
        {
          method: "POST",
          headers: {
            "x-review-tunnel-client": "1",
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Bearer ${clientLogin.sessionToken}`,
          },
          body: new URLSearchParams({
            purpose: "resume",
            tunnelId: issued.tunnelId,
          }).toString(),
        },
      );
      assert.equal(resumeCredential.status, 201);
    }
    const boundedResumeCredential = await send(
      gatewayPort,
      "control.localhost",
      "/api/carrier-credentials",
      {
        method: "POST",
        headers: {
          "x-review-tunnel-client": "1",
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${clientLogin.sessionToken}`,
        },
        body: new URLSearchParams({
          purpose: "resume",
          tunnelId: issued.tunnelId,
        }).toString(),
      },
    );
    assert.equal(boundedResumeCredential.status, 429);
    assert.equal(boundedResumeCredential.headers["retry-after"], "60");
    const rejectedReviewerClient = await send(
      gatewayPort,
      "control.localhost",
      "/api/client/login",
      {
        method: "POST",
        headers: {
          "x-review-tunnel-client": "1",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          username: "reviewer",
          password: "reviewer-password-2026",
        }).toString(),
      },
    );
    assert.equal(rejectedReviewerClient.status, 403);
    assert.ok(loggedOutAccountIds.includes(reviewer.principal.accountId));

    const overAccountQuota = await send(
      gatewayPort,
      "control.localhost",
      "/api/carrier-credentials",
      {
        method: "POST",
        headers: {
          "x-review-tunnel-client": "1",
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${clientLogin.sessionToken}`,
        },
        body: new URLSearchParams({ purpose: "create" }).toString(),
      },
    );
    assert.equal(overAccountQuota.status, 429);

    const unauthenticated = await get(gatewayPort, securedHost, "/", {});
    assert.equal(unauthenticated.status, 401);
    const unknownTunnel = await get(gatewayPort, "unknown-tunnel.localhost", "/", {});
    assert.equal(unknownTunnel.status, unauthenticated.status);

    const adminPage = await get(gatewayPort, "control.localhost", "/admin/users", {
      cookie: `rt_control_dev=${encodeURIComponent(administrator.sessionToken)}`,
    });
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.body, /계정 관리/);
    assert.equal(
      adminPage.body.includes(
        `action="/admin/users/${encodeURIComponent(administrator.principal.accountId)}/reset"`,
      ),
      false,
    );

    const rejectedSelfReset = await send(
      gatewayPort,
      "control.localhost",
      `/admin/users/${encodeURIComponent(administrator.principal.accountId)}/reset`,
      {
        method: "POST",
        headers: {
          origin: "http://control.localhost",
          cookie: `rt_control_dev=${encodeURIComponent(administrator.sessionToken)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          adminPassword: "administrator-password-2026",
        }).toString(),
      },
    );
    assert.equal(rejectedSelfReset.status, 400);
    assert.match(rejectedSelfReset.body, /자신의 비밀번호/);
    await authService.verifyAdministratorCredentials({
      username: "admin",
      password: "administrator-password-2026",
      remoteAddress: "127.0.0.1",
    });

    const logoutCountBeforeAdministratorConfirmation = loggedOutAccountIds.length;
    const createdByWeb = await send(gatewayPort, "control.localhost", "/admin/users", {
      method: "POST",
      headers: {
        origin: "http://control.localhost",
        cookie: `rt_control_dev=${encodeURIComponent(administrator.sessionToken)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: "web-reviewer",
        displayName: "Web Reviewer",
        roles: "REVIEWER",
        adminPassword: "administrator-password-2026",
      }).toString(),
    });
    assert.equal(createdByWeb.status, 201);
    assert.match(createdByWeb.body, /다시 표시되지 않습니다/);
    assert.strictEqual(createAccountActor, lastConfirmedAuthorization);
    assert.equal(loggedOutAccountIds.length, logoutCountBeforeAdministratorConfirmation);

    for (const roles of [["ADMIN", "UNKNOWN"], ["REVIEWER", "REVIEWER"]]) {
      const invalidRoles = new URLSearchParams({
        username: `invalid-role-${roles[0]?.toLowerCase()}`,
        displayName: "Invalid role",
        adminPassword: "administrator-password-2026",
      });
      for (const role of roles) invalidRoles.append("roles", role);
      const rejectedRoles = await send(
        gatewayPort,
        "control.localhost",
        "/admin/users",
        {
          method: "POST",
          headers: {
            origin: "http://control.localhost",
            cookie: `rt_control_dev=${encodeURIComponent(administrator.sessionToken)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: invalidRoles.toString(),
        },
      );
      assert.equal(rejectedRoles.status, 400);
    }

    const browserStart = await get(gatewayPort, securedHost, "/private", {
      accept: "text/html",
    });
    assert.equal(browserStart.status, 303);
    const intent = new URL(browserStart.location ?? "http://invalid").searchParams.get("intent");
    assert.ok(intent !== null);
    assert.equal(loginIntentCreateCalls, 1);
    const limitedIntent = await get(gatewayPort, securedHost, "/another", {
      accept: "text/html",
    });
    assert.equal(limitedIntent.status, 429);
    assert.equal(limitedIntent.headers["retry-after"], "60");
    assert.equal(loginIntentCreateCalls, 2);
    const exhaustedIntentStorage = await get(
      gatewayPort,
      "other-tunnel.localhost",
      "/review",
      { accept: "text/html" },
    );
    assert.equal(exhaustedIntentStorage.status, 429);
    assert.equal(exhaustedIntentStorage.headers["retry-after"], "60");
    assert.equal(loginIntentCreateCalls, 2);
    const browserLogin = await send(gatewayPort, "control.localhost", "/login", {
      method: "POST",
      headers: {
        origin: "http://control.localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: reviewer.principal.username,
        password: "reviewer-password-2026",
        intent,
      }).toString(),
    });
    assert.equal(browserLogin.status, 303);
    assert.match(browserLogin.location ?? "", /\/_review-tunnel\/session\?code=/);
    const exchangeLocation = new URL(browserLogin.location ?? "http://invalid");
    const browserExchange = await get(
      gatewayPort,
      securedHost,
      exchangeLocation.pathname + exchangeLocation.search,
      { accept: "text/html" },
    );
    assert.equal(browserExchange.status, 303);
    const contentCookie = browserExchange.setCookie[0]?.split(";", 1)[0];
    assert.match(contentCookie ?? "", /^rt_session_dev=/);

    const authorized = await get(gatewayPort, securedHost, "/private", {
      cookie: `${contentCookie}; app_session=visible-to-app`,
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body, "private preview");
    assert.deepEqual(authorized.setCookie, ["app_session=updated; Path=/"]);
    assert.equal(authorized.headers["content-security-policy"], undefined);
    assert.equal(authorized.headers["x-frame-options"], undefined);

    authorizationDatabaseAvailable = false;
    await Promise.race([
      Promise.all([client.closed, secondClient.closed]),
      delay(250).then(() => {
        throw new Error("authorization outage did not fail closed within the bounded deadline");
      }),
    ]);
    assert.equal(
      authorizationOutageChecks,
      1,
      "authorization queries were multiplied for the same account version and role",
    );
    authorizationDatabaseAvailable = true;
    const revoked = await get(gatewayPort, securedHost, "/private", {
      cookie: `${contentCookie}; app_session=visible-to-app`,
    });
    assert.ok(revoked.status === 404 || revoked.status === 503);
    assert.ok(gatewayEvents.includes("authorization.revalidation_failed"));

    const operator = await authService.authenticate({
      username: "admin",
      password: "administrator-password-2026",
      remoteAddress: "127.0.0.1",
    });
    const operationsPage = await get(gatewayPort, "control.localhost", "/admin/operations", {
      cookie: `rt_control_dev=${encodeURIComponent(operator.sessionToken)}`,
    });
    assert.equal(operationsPage.status, 200);
    assert.match(operationsPage.body, /kill switch/);
    const invalidKillSwitch = await send(
      gatewayPort,
      "control.localhost",
      "/admin/operations/kill-switch",
      {
        method: "POST",
        headers: {
          origin: "http://control.localhost",
          cookie: `rt_control_dev=${encodeURIComponent(operator.sessionToken)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          enabled: "falsee",
          adminPassword: "administrator-password-2026",
        }).toString(),
      },
    );
    assert.equal(invalidKillSwitch.status, 400);
    assert.equal(gateway.isKillSwitchEnabled(), false);
    assert.deepEqual(persistedKillSwitchValues, []);
    const enableKillSwitch = await send(
      gatewayPort,
      "control.localhost",
      "/admin/operations/kill-switch",
      {
        method: "POST",
        headers: {
          origin: "http://control.localhost",
          cookie: `rt_control_dev=${encodeURIComponent(operator.sessionToken)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          enabled: "true",
          adminPassword: "administrator-password-2026",
        }).toString(),
      },
    );
    assert.equal(enableKillSwitch.status, 200);
    assert.equal(gateway.isKillSwitchEnabled(), true);
    const disableKillSwitch = await send(
      gatewayPort,
      "control.localhost",
      "/admin/operations/kill-switch",
      {
        method: "POST",
        headers: {
          origin: "http://control.localhost",
          cookie: `rt_control_dev=${encodeURIComponent(operator.sessionToken)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          enabled: "false",
          adminPassword: "administrator-password-2026",
        }).toString(),
      },
    );
    assert.equal(disableKillSwitch.status, 200);
    assert.equal(gateway.isKillSwitchEnabled(), false);
    assert.deepEqual(persistedKillSwitchValues, [true, false]);
  } finally {
    await client.disconnect();
    await secondClient?.disconnect();
    await gateway.close();
    origin.close();
    await once(origin, "close");
  }
});

async function get(
  port: number,
  host: string,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<Readonly<{
  status: number;
  body: string;
  setCookie: readonly string[];
  headers: import("node:http").IncomingHttpHeaders;
  location?: string;
}>> {
  return send(port, host, path, { method: "GET", headers });
}

async function send(
  port: number,
  host: string,
  path: string,
  input: Readonly<{
    method: "GET" | "POST";
    headers: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Promise<Readonly<{
  status: number;
  body: string;
  setCookie: readonly string[];
  headers: import("node:http").IncomingHttpHeaders;
  location?: string;
}>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      method: input.method,
      headers: { host, accept: "application/json", ...input.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          setCookie: response.headers["set-cookie"] ?? [],
          headers: response.headers,
          ...(location === undefined ? {} : { location }),
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end(input.body);
  });
}
