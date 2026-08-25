import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

import { connectTunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "./server.ts";

test("LAN routing bootstraps a signed route cookie and carries HTTP and WebSocket traffic", async (context) => {
  const origin = createServer((incoming, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("set-cookie", [
      "rt_lan_route=attacker; Path=/",
      "app_session=response; Path=/",
    ]);
    response.end(JSON.stringify({
      path: incoming.url,
      cookie: incoming.headers.cookie ?? null,
    }));
  });
  const localWebSockets = new WebSocketServer({ server: origin, perMessageDeflate: false });
  localWebSockets.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  const originPort = await listen(origin);
  context.after(async () => {
    for (const socket of localWebSockets.clients) socket.terminate();
    await new Promise<void>((resolve) => localWebSockets.close(() => resolve()));
    await close(origin);
  });

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "127.0.0.1",
    contentRouting: "lan-cookie",
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "lan-routing-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  const activation = await client.ready;
  assert.match(
    activation.shareUrl,
    new RegExp(`^http://127\\.0\\.0\\.1:${gatewayPort}/_review-tunnel/lan/lan-routing-test/[A-Za-z0-9_-]+$`),
  );

  const withoutRoute = await send(gatewayPort, "/");
  assert.equal(withoutRoute.statusCode, 503);

  const bootstrapPath = new URL(activation.shareUrl).pathname;
  const tamperedBootstrap = await send(gatewayPort, `${bootstrapPath.slice(0, -1)}x`);
  assert.equal(tamperedBootstrap.statusCode, 404);
  const tamperedCookie = await send(gatewayPort, "/", {
    cookie: "rt_lan_route=lan-routing-test.invalid",
  });
  assert.equal(tamperedCookie.statusCode, 503);

  const bootstrap = await send(gatewayPort, bootstrapPath);
  assert.equal(bootstrap.statusCode, 303);
  assert.equal(bootstrap.headers.location, "/");
  const routeCookie = bootstrap.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  assert.match(routeCookie ?? "", /^rt_lan_route=/);
  assert.match(bootstrap.headers["set-cookie"]?.[0] ?? "", /HttpOnly; SameSite=Lax/);

  const proxied = await send(gatewayPort, "/from-phone", {
    cookie: `${routeCookie}; app_session=request`,
  });
  assert.equal(proxied.statusCode, 200);
  assert.deepEqual(JSON.parse(proxied.body.toString()), {
    path: "/from-phone",
    cookie: "app_session=request",
  });
  assert.deepEqual(proxied.headers["set-cookie"], ["app_session=response; Path=/"]);

  const reviewer = new WebSocket(`ws://127.0.0.1:${gatewayPort}/socket`, {
    perMessageDeflate: false,
    headers: { cookie: routeCookie },
  });
  context.after(() => reviewer.terminate());
  await once(reviewer, "open");
  const expected = Buffer.from([0, 1, 2, 253, 254, 255]);
  reviewer.send(expected);
  const [message, isBinary] = await once(reviewer, "message") as [Buffer, boolean];
  assert.equal(isBinary, true);
  assert.deepEqual(Buffer.from(message), expected);
});

test("LAN cookie routing cannot accidentally enable the authenticated control plane", () => {
  assert.throws(
    () => createGatewayServer({
      contentRouting: "lan-cookie",
      authService: {} as never,
    }),
    /cannot be combined with authenticated mode/,
  );
});

function send(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Readonly<{
  statusCode: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
}>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      headers,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => resolve({
        statusCode: incoming.statusCode ?? 0,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not listen");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
