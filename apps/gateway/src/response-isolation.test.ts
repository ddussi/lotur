import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { connectTunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "./server.ts";

for (const kind of ["HTTP", "WEBSOCKET"] as const) {
  for (const invalid of ["header count", "header bytes"] as const) {
    test(`${kind} excessive response ${invalid} resets only its stream`, { timeout: 10_000 }, async (context) => {
      const extraHeaders = invalid === "header count"
        ? Array.from({ length: 257 }, (_, index) => [`x-test-${index}`, "x"] as const)
        : [["x-large", "x".repeat(70_000)] as const];
      let held: ServerResponse | undefined;
      const origin = createServer((incoming, response) => {
        if (incoming.url === "/held") {
          held = response;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: started\n\n");
        } else {
          if (incoming.url === "/invalid") for (const [name, value] of extraHeaders) response.setHeader(name, value);
          response.end("healthy");
        }
      });
      const originSockets = new WebSocketServer({ server: origin });
      originSockets.on("headers", (headers, incoming) => {
        if (incoming.url === "/invalid") headers.push(...extraHeaders.map(([name, value]) => `${name}: ${value}`));
      });
      originSockets.on("connection", socket => {
        socket.on("error", () => undefined);
        socket.on("message", data => socket.send(data));
      });
      origin.listen(0, "127.0.0.1");
      await once(origin, "listening");
      const address = origin.address();
      assert.ok(address !== null && typeof address !== "string");
      const gateway = createGatewayServer();
      const port = await gateway.listen();
      const client = connectTunnelClient({ gatewayUrl: `ws://127.0.0.1:${port}/_review-tunnel/carrier`,
        tunnelId: "response-isolation", localOrigin: `http://127.0.0.1:${address.port}` });
      let streaming: IncomingMessage | undefined;
      let echo: WebSocket | undefined;
      context.after(async () => {
        streaming?.destroy(); echo?.terminate();
        await client.disconnect(); await gateway.close();
        for (const peer of originSockets.clients) peer.terminate();
        originSockets.close(); origin.closeAllConnections();
        await new Promise<void>(resolve => origin.close(() => resolve()));
      });
      await client.ready;
      streaming = await get(port, "/held");
      streaming.on("error", () => undefined);
      await once(streaming, "data");
      echo = new WebSocket(`ws://127.0.0.1:${port}/echo`, { headers: { host: "response-isolation.localhost" } });
      echo.on("error", () => undefined);
      await once(echo, "open");

      if (kind === "HTTP") {
        const response = await get(port, "/invalid");
        const body = await collect(response);
        assert.equal(response.statusCode, 502, body);
        assert.match(body, invalid === "header count" ? /LOCAL_RESPONSE_ERROR/ : /LOCAL_ORIGIN_ERROR/);
      } else {
        const raw = connect({ host: "127.0.0.1", port });
        context.after(() => raw.destroy());
        raw.write("GET /invalid HTTP/1.1\r\nHost: response-isolation.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
        assert.match(await collect(raw), /^HTTP\/1\.1 502 /);
      }
      assert.equal(streaming.destroyed, false);
      assert.ok(held !== undefined);
      const remaining = collect(streaming);
      held.end("data: survived\n\n");
      assert.match(await remaining, /survived/);
      const echoed = once(echo, "message");
      echo.send("survived");
      assert.equal(String((await echoed)[0]), "survived");
      const next = await get(port, "/");
      assert.equal(next.statusCode, 200);
      assert.equal(await collect(next), "healthy");
    });
  }
}

function get(port: number, path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, headers: { host: "response-isolation.localhost" } }, resolve);
    outgoing.on("error", reject); outgoing.end();
  });
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
