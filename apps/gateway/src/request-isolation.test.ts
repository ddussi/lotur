import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { connectTunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "./server.ts";

for (const kind of ["HTTP", "WEBSOCKET"] as const) {
  for (const invalid of ["headers", "path"] as const) {
    test(`${kind} invalid ${invalid} rejects only that request and preserves active and subsequent streams`, {
      timeout: 10_000,
    }, async (context) => {
      let heldResponse: ServerResponse | undefined;
      const origin = createServer((incoming, response) => {
        if (incoming.url === "/held") {
          heldResponse = response;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: started\n\n");
        } else response.end("healthy");
      });
      const originWebSockets = new WebSocketServer({ server: origin });
      originWebSockets.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
      origin.listen(0, "127.0.0.1");
      await once(origin, "listening");
      const address = origin.address();
      assert.ok(address !== null && typeof address !== "string");
      const gateway = createGatewayServer();
      const port = await gateway.listen();
      const client = connectTunnelClient({
        gatewayUrl: `ws://127.0.0.1:${port}/_review-tunnel/carrier`,
        tunnelId: "request-isolation",
        localOrigin: `http://127.0.0.1:${address.port}`,
      });
      let streaming: IncomingMessage | undefined;
      let socket: WebSocket | undefined;
      context.after(async () => {
        streaming?.destroy();
        socket?.terminate();
        await client.disconnect();
        await gateway.close();
        for (const peer of originWebSockets.clients) peer.terminate();
        originWebSockets.close();
        origin.closeAllConnections();
        await new Promise<void>((resolve) => origin.close(() => resolve()));
      });
      await client.ready;
      streaming = await get(port, "/held");
      streaming.on("error", () => undefined);
      await once(streaming, "data");
      socket = new WebSocket(`ws://127.0.0.1:${port}/echo`, { headers: { host: "request-isolation.localhost" } });
      socket.on("error", () => undefined);
      await once(socket, "open");

      const raw = connect({ host: "127.0.0.1", port });
      context.after(() => raw.destroy());
      const target = invalid === "path" ? "/invalid#fragment" : "/";
      const headers = ["Host: request-isolation.localhost", "Connection: close"];
      if (kind === "WEBSOCKET") headers.push(
        "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      );
      if (invalid === "headers") {
        headers.push(...Array.from({ length: 257 }, (_, index) => `X-Test-${index}: x`));
      }
      raw.write(`GET ${target} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      const rejected = await collect(raw);
      assert.match(rejected, invalid === "headers" ? /^HTTP\/1\.1 431 / : /^HTTP\/1\.1 400 /);

      assert.equal(streaming.destroyed, false);
      assert.ok(heldResponse !== undefined);
      const remainingData = collect(streaming);
      heldResponse.end("data: survived\n\n");
      assert.match(await remainingData, /survived/);
      const echoed = once(socket, "message");
      socket.send("survived");
      assert.equal(String((await echoed)[0]), "survived");
      const response = await get(port, "/");
      assert.equal(response.statusCode, 200);
      assert.equal(await collect(response), "healthy");
    });
  }
}

function get(port: number, path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, headers: { host: "request-isolation.localhost" } }, resolve);
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
