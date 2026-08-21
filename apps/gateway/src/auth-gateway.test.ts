import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import {
  AuthService,
  InMemoryAuthRepository,
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

test("internal accounts gate HTTP, admin UI and Carrier, then revoke an active Tunnel", async () => {
  const repository = new InMemoryAuthRepository();
  const authService = new AuthService({
    repository,
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 3),
    dummyPasswordHash: "hashed:dummy-password",
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
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 20,
  });
  const gatewayPort = await gateway.listen();
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

  try {
    await client.ready;
    const unauthenticated = await get(gatewayPort, securedHost, "/", {});
    assert.equal(unauthenticated.status, 401);
    const unknownTunnel = await get(gatewayPort, "unknown-tunnel.localhost", "/", {});
    assert.equal(unknownTunnel.status, unauthenticated.status);

    const adminPage = await get(gatewayPort, "control.localhost", "/admin/users", {
      cookie: `rt_control_dev=${encodeURIComponent(administrator.sessionToken)}`,
    });
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.body, /계정 관리/);

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

    const browserStart = await get(gatewayPort, securedHost, "/private", {
      accept: "text/html",
    });
    assert.equal(browserStart.status, 303);
    const intent = new URL(browserStart.location ?? "http://invalid").searchParams.get("intent");
    assert.ok(intent !== null);
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

    await authService.setAccountRoles(
      administrator.principal,
      administrator.principal.accountId,
      ["ADMIN"],
    );
    await delay(80);
    const revoked = await get(gatewayPort, securedHost, "/private", {
      cookie: `${contentCookie}; app_session=visible-to-app`,
    });
    assert.equal(revoked.status, 404);

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
  } finally {
    await client.disconnect();
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
          ...(location === undefined ? {} : { location }),
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end(input.body);
  });
}
