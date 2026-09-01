import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { AuthService, InMemoryAuthRepository, type AccountRole, type Principal } from "../../../packages/auth/src/index.ts";
import { connectTunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "./server.ts";

for (const roles of [["DEVELOPER"], ["REVIEWER"], ["DEVELOPER", "REVIEWER"], ["ADMIN", "DEVELOPER"]] satisfies AccountRole[][]) {
  for (const revoke of ["disable", "roles"] as const) {
    test(`content revalidation preserves ${roles.join("+")} SSE and WebSocket until ${revoke}`, { timeout: 10_000 }, async (context) => {
      const repository = new InMemoryAuthRepository();
      for (const [id, accountRoles] of [["owner", ["DEVELOPER"]], ["viewer", roles], ["administrator", ["ADMIN"]]] as const) {
        repository.accounts.set(id, {
          id, username: id, displayName: id, roles: accountRoles,
          passwordHash: "test-password", enabled: true, mustChangePassword: false,
          authVersion: 1, createdAt: new Date(), updatedAt: new Date(),
        });
      }
      const authService = new AuthService({
        repository,
        passwordHasher: { async hash(password) { return password; }, async verify(hash, password) { return hash === password; } },
        sessionHmacKey: Buffer.alloc(32, 17), dummyPasswordHash: "dummy",
        authenticationEventSink: { write() {}, reportFailure() {} },
      });
      const [owner, viewer, administrator] = await Promise.all(["owner", "viewer", "administrator"].map((username) =>
        authService.authenticate({ username, password: "test-password", remoteAddress: "127.0.0.1" })));
      assert.ok(owner !== undefined && viewer !== undefined && administrator !== undefined);
      let held: ServerResponse | undefined;
      const origin = createServer((incoming, response) => {
        if (incoming.url !== "/events") return void response.end("healthy");
        held = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: ready\n\n");
      });
      const originSockets = new WebSocketServer({ server: origin });
      originSockets.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
      origin.listen(0, "127.0.0.1");
      await once(origin, "listening");
      const address = origin.address();
      assert.ok(address !== null && typeof address !== "string");
      let checksEnabled = false;
      const checked = Promise.withResolvers<boolean>();
      const actualChecks = authService.areAccountsAuthorized.bind(authService);
      authService.areAccountsAuthorized = async (checks) => {
        if (!checksEnabled) return checks.map(() => true);
        const result = await actualChecks(checks);
        const index = checks.findIndex((check) => check.accountId === viewer.principal.accountId);
        if (index >= 0) checked.resolve(result[index] ?? false);
        return result;
      };
      const gateway = createGatewayServer({ authService, secureCookies: false, controlHost: "127.0.0.1", contentDomain: "localhost", authorizationCheckIntervalMs: 10 });
      const port = await gateway.listen();
      const credential = await authService.issueCarrierCredential(owner.principal, { purpose: "create", tunnelId: "content-policy" });
      const client = connectTunnelClient({
        gatewayUrl: `ws://127.0.0.1:${port}/_review-tunnel/carrier`, tunnelId: "content-policy",
        localOrigin: `http://127.0.0.1:${address.port}`, carrierCredential: credential,
      });
      let incoming: IncomingMessage | undefined;
      let socket: WebSocket | undefined;
      context.after(async () => {
        incoming?.destroy();
        socket?.terminate();
        await client.disconnect();
        await gateway.close();
        for (const peer of originSockets.clients) peer.terminate();
        originSockets.close();
        origin.closeAllConnections();
        await new Promise<void>((resolve) => origin.close(() => resolve()));
      });
      await client.ready;
      const cookie = await contentCookie(authService, viewer.principal);
      incoming = await get(port, "/events", cookie);
      incoming.on("error", () => undefined);
      assert.equal(incoming.statusCode, 200);
      await once(incoming, "data");
      socket = new WebSocket(`ws://127.0.0.1:${port}/echo`, { headers: { host: "content-policy.localhost", cookie } });
      socket.on("error", () => undefined);
      await once(socket, "open");
      checksEnabled = true;
      assert.equal(await checked.promise, true, "initially allowed content access must survive revalidation");
      const echoed = once(socket, "message");
      socket.send("still connected");
      assert.equal(String((await echoed)[0]), "still connected");
      assert.ok(held !== undefined);
      const streamed = once(incoming, "data");
      held.write("data: still connected\n\n");
      assert.match(String((await streamed)[0]), /still connected/);

      const httpClosed = new Promise<void>((resolve) => incoming!.once("close", resolve));
      const socketClosed = once(socket, "close");
      if (revoke === "disable") await authService.setAccountEnabled(administrator.principal, viewer.principal.accountId, false);
      else await authService.setAccountRoles(administrator.principal, viewer.principal.accountId, ["ADMIN"]);
      await Promise.all([httpClosed, socketClosed]);
      assert.equal(incoming.aborted, true);
      const unaffected = await get(port, "/", await contentCookie(authService, owner.principal));
      assert.equal(unaffected.statusCode, 200);
      unaffected.resume();
      await once(unaffected, "end");
    });
  }
}

async function contentCookie(service: AuthService, principal: Principal): Promise<string> {
  const host = "content-policy.localhost";
  const intent = await service.createLoginIntent(host, "/");
  const exchange = await service.createSessionExchange(principal, intent);
  const session = await service.consumeSessionExchange(exchange.code, host);
  return `rt_session_dev=${session.sessionToken}`;
}

function get(port: number, path: string, cookie: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, headers: { host: "content-policy.localhost", cookie } }, resolve);
    outgoing.on("error", reject);
    outgoing.end();
  });
}
