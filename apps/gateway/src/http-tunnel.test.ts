import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

import { connectTunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "./server.ts";

test("POST body와 origin response를 Carrier로 streaming 중계한다", async (context) => {
  const origin = createServer(async (incoming, response) => {
    response.writeHead(201, { "content-type": "application/octet-stream" });
    for await (const chunk of incoming) {
      response.write(chunk);
    }
    response.end();
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "echo-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const result = await sendRequest({
    port: gatewayPort,
    host: "echo-test.localhost",
    method: "POST",
    path: "/echo?value=1",
    chunks: [Buffer.from([0, 1, 2]), Buffer.from([253, 254, 255])],
  });

  assert.equal(result.statusCode, 201);
  assert.equal(result.headers["content-type"], "application/octet-stream");
  assert.deepEqual(result.body, Buffer.from([0, 1, 2, 253, 254, 255]));
});

test("초기 flow-control window보다 큰 body도 bounded credit으로 왕복한다", async (context) => {
  const origin = createServer(async (incoming, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    for await (const chunk of incoming) response.write(chunk);
    response.end();
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "window-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const payload = Buffer.alloc(1024 * 1024 + 17);
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] = index % 251;
  }
  const result = await sendRequest({
    port: gatewayPort,
    host: "window-test.localhost",
    method: "POST",
    path: "/large",
    chunks: [payload],
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, payload);
});

test("SSE 첫 chunk를 origin 종료 전에 검토자에게 flush한다", async (context) => {
  let releaseOrigin!: () => void;
  const originReleased = new Promise<void>((resolve) => {
    releaseOrigin = resolve;
  });
  const origin = createServer(async (_incoming, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write("data: first\n\n");
    await originReleased;
    response.end("data: second\n\n");
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "sse-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const response = request({
    host: "127.0.0.1",
    port: gatewayPort,
    path: "/events",
    headers: { host: "sse-test.localhost" },
  });
  response.end();
  const incoming = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => response.once("response", resolve).once("error", reject),
  );

  const firstChunk = await Promise.race([
    new Promise<Buffer>((resolve) => incoming.once("data", resolve)),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("SSE first chunk was buffered")), 1_000),
    ),
  ]);
  assert.equal(firstChunk.toString(), "data: first\n\n");

  releaseOrigin();
  const remaining = await collect(incoming);
  assert.equal(remaining.toString(), "data: second\n\n");
});

test("WebSocket 101 이후 binary frame과 정상 close를 raw 중계한다", async (context) => {
  const origin = createServer();
  const localWebSockets = new WebSocketServer({
    server: origin,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has("review-test") ? "review-test" : false;
    },
  });
  localWebSockets.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  const originPort = await listen(origin);
  context.after(async () => {
    for (const socket of localWebSockets.clients) socket.terminate();
    await new Promise<void>((resolve) => localWebSockets.close(() => resolve()));
    await close(origin);
  });

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "websocket-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const reviewer = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/socket`,
    "review-test",
    {
      perMessageDeflate: false,
      headers: { host: "websocket-test.localhost" },
    },
  );
  context.after(() => reviewer.terminate());
  await onceEvent(reviewer, "open");
  assert.equal(reviewer.protocol, "review-test");

  const expected = Buffer.from([0, 1, 2, 253, 254, 255]);
  reviewer.send(expected);
  const [data, isBinary] = await onceEvent<[Buffer, boolean]>(reviewer, "message");
  assert.equal(isBinary, true);
  assert.deepEqual(Buffer.from(data), expected);

  const closed = onceEvent<[number, Buffer]>(reviewer, "close");
  reviewer.close(1000, "done");
  const [code, reason] = await closed;
  assert.equal(code, 1000);
  assert.equal(reason.toString(), "done");
});

test("검토자가 SSE를 취소하면 로컬 response도 종료한다", async (context) => {
  let localClosed!: () => void;
  const localClose = new Promise<void>((resolve) => {
    localClosed = resolve;
  });
  const origin = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    response.once("close", localClosed);
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "cancel-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const outgoing = request({
    host: "127.0.0.1",
    port: gatewayPort,
    path: "/events",
    headers: { host: "cancel-test.localhost" },
  });
  outgoing.end();
  const incoming = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => outgoing.once("response", resolve).once("error", reject),
  );
  await onceEvent<[Buffer]>(incoming, "data");
  incoming.destroy();

  await Promise.race([
    localClose,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("cancel did not reach local response")), 1_000),
    ),
  ]);
});

test("Carrier 단절 뒤 Resume secret으로 같은 URL을 generation 2에서 복구한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("resumed"));
  const originPort = await listen(origin);
  context.after(() => close(origin));

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const initialClient = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "resume-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  const initial = await initialClient.ready;
  assert.equal(initial.generation, 1);
  await initialClient.disconnect();
  await delay(10);

  const rejectedClient = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "resume-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
    resumeSecret: "A".repeat(43),
  });
  await assert.rejects(rejectedClient.ready);

  const resumedClient = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "resume-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
    resumeSecret: initial.resumeSecret,
  });
  context.after(() => resumedClient.close());
  const resumed = await resumedClient.ready;
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.resumeSecret, initial.resumeSecret);

  const result = await sendRequest({
    port: gatewayPort,
    host: "resume-test.localhost",
    method: "GET",
    path: "/after-resume",
    chunks: [],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString(), "resumed");
});

test("명시적 Client 종료는 URL과 Resume secret을 즉시 폐기한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("should-not-run"));
  const originPort = await listen(origin);
  context.after(() => close(origin));

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "close-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  const activation = await client.ready;
  await client.close();
  await delay(10);

  const result = await sendRequest({
    port: gatewayPort,
    host: "close-test.localhost",
    method: "GET",
    path: "/after-close",
    chunks: [],
  });
  assert.equal(result.statusCode, 503);

  const rejectedResume = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "close-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
    resumeSecret: activation.resumeSecret,
  });
  await assert.rejects(rejectedResume.ready);
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error == null ? resolve() : reject(error))),
  );
}

async function sendRequest(input: Readonly<{
  port: number;
  host: string;
  method: string;
  path: string;
  chunks: readonly Buffer[];
}>): Promise<{
  statusCode: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
}> {
  const outgoing = request({
    host: "127.0.0.1",
    port: input.port,
    method: input.method,
    path: input.path,
    headers: {
      host: input.host,
      "content-type": "application/octet-stream",
    },
  });
  const incomingPromise = new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => outgoing.once("response", resolve).once("error", reject),
  );
  for (const chunk of input.chunks) outgoing.write(chunk);
  outgoing.end();
  const incoming = await incomingPromise;
  return {
    statusCode: incoming.statusCode ?? 0,
    headers: incoming.headers,
    body: await collect(incoming),
  };
}

async function collect(
  stream: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function onceEvent<T extends unknown[] = []>(
  target: NodeJS.EventEmitter,
  event: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onEvent = (...values: unknown[]) => {
      cleanup();
      resolve(values as T);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      target.off(event, onEvent);
      target.off("error", onError);
    };
    target.once(event, onEvent);
    target.once("error", onError);
  });
}
