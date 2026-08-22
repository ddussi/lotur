import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { connect as connectTcp } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

import {
  connectResilientTunnelClient,
  connectTunnelClient,
  TunnelConnectionError,
} from "../../client/src/client.ts";
import {
  CARRIER_PROFILE,
  decodeEnvelope,
  decodeSessionConfigMetadata,
  encodeEnvelope,
  encodeMetadata,
  FrameType,
} from "../../../packages/protocol/src/index.ts";
import { createGatewayServer } from "./server.ts";

test("generic CONNECT와 WebSocket 이외 Upgrade를 명시적으로 거부한다", async (context) => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const connectResponse = await rawHttp(
    gatewayPort,
    "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n",
  );
  assert.match(connectResponse, /^HTTP\/1\.1 501 /);
  assert.match(connectResponse, /CONNECT_NOT_SUPPORTED/);

  const upgradeResponse = await rawHttp(
    gatewayPort,
    "GET / HTTP/1.1\r\nHost: unsupported.localhost\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
  );
  assert.match(upgradeResponse, /^HTTP\/1\.1 501 /);
  assert.match(upgradeResponse, /UNSUPPORTED_UPGRADE/);
});

test("activation gate가 실패하면 공유 URL을 한 번도 열지 않는다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("must stay private"));
  const originPort = await listen(origin);
  context.after(() => close(origin));

  let admissionChecked!: () => void;
  const checked = new Promise<void>((resolve) => {
    admissionChecked = resolve;
  });
  const gateway = createGatewayServer({
    gatewayAdmissionReady() {
      admissionChecked();
      return false;
    },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "closed-gate-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.disconnect());
  const rejected = assert.rejects(
    client.ready,
    (error: unknown) =>
      error instanceof TunnelConnectionError && error.code === "RELAY_NOT_READY",
  );

  await checked;
  const result = await sendRequest({
    port: gatewayPort,
    host: "closed-gate-test.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(result.statusCode, 503);
  await rejected;
});

test("전용 authenticated canary는 admission과 kill switch에 의존하지 않는다", async (context) => {
  const token = "canary-token-that-is-at-least-32-bytes";
  const gateway = createGatewayServer({
    gatewayAdmissionReady: () => false,
    initialKillSwitch: true,
    canaryHost: "canary.localhost",
    canaryBearerToken: token,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const negative = await sendRequest({
    port: gatewayPort,
    host: "canary.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(negative.statusCode, 401);

  const authorized = await sendRequest({
    port: gatewayPort,
    host: "canary.localhost",
    method: "GET",
    path: "/",
    chunks: [],
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.statusCode, 200);
  assert.match(authorized.body.toString(), /review-tunnel-canary-v1/);

  let uploadEnded = false;
  const upload = request({
    host: "127.0.0.1",
    port: gatewayPort,
    method: "POST",
    path: "/request-stream",
    headers: {
      host: "canary.localhost",
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    },
  });
  const streamedResponse = onceEvent<[import("node:http").IncomingMessage]>(upload, "response");
  upload.write("first");
  const [incoming] = await streamedResponse;
  assert.equal(uploadEnded, false);
  uploadEnded = true;
  upload.end("second");
  assert.match((await collect(incoming)).toString(), /request-first/);

  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/websocket`, {
    headers: {
      host: "canary.localhost",
      authorization: `Bearer ${token}`,
    },
  });
  context.after(() => socket.terminate());
  await onceEvent(socket, "open");
  const message = onceEvent<[Buffer, boolean]>(socket, "message");
  socket.send(Buffer.from("canary-echo"));
  const [received, binary] = await message;
  assert.equal(binary, true);
  assert.equal(received.toString(), "canary-echo");
  socket.close(1000);
});

test("초기 로컬 origin 점검 실패는 activation 전에 종료한다", async (context) => {
  const unavailableOrigin = createServer();
  const unavailablePort = await listen(unavailableOrigin);
  await close(unavailableOrigin);

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "origin-down-test",
    localOrigin: `http://127.0.0.1:${unavailablePort}`,
  });
  context.after(() => client.disconnect());

  await assert.rejects(
    client.ready,
    (error: unknown) =>
      error instanceof TunnelConnectionError &&
      error.code === "LOCAL_ORIGIN_UNAVAILABLE",
  );
  const result = await sendRequest({
    port: gatewayPort,
    host: "origin-down-test.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(result.statusCode, 503);
});

test("실제 Gateway idle timer가 Stream 없는 Session을 종료한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("too late"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionPolicy: {
      maxTtlMs: 2_000,
      idleTimeoutMs: 60,
      reconnectGraceMs: 100,
    },
    sessionTickIntervalMs: 10,
    heartbeatIntervalMs: 20,
    carrierLeaseMs: 100,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "idle-expiry-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  await delay(100);
  const result = await sendRequest({
    port: gatewayPort,
    host: "idle-expiry-test.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(result.statusCode, 503);
});

test("PING/PONG heartbeat가 살아 있는 Carrier lease를 유지한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("still alive"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionPolicy: {
      maxTtlMs: 2_000,
      idleTimeoutMs: 1_000,
      reconnectGraceMs: 100,
    },
    sessionTickIntervalMs: 10,
    heartbeatIntervalMs: 20,
    carrierLeaseMs: 100,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "heartbeat-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  await delay(160);
  const result = await sendRequest({
    port: gatewayPort,
    host: "heartbeat-test.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString(), "still alive");
});

test("developer authorization max-age가 실제 Carrier와 route를 종료한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("expired"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionPolicy: {
      maxTtlMs: 2_000,
      idleTimeoutMs: 1_000,
      reconnectGraceMs: 100,
    },
    authorizationMaxAgeMs: 60,
    sessionTickIntervalMs: 10,
    heartbeatIntervalMs: 20,
    carrierLeaseMs: 100,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "authorization-expiry-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  await delay(100);
  const result = await sendRequest({
    port: gatewayPort,
    host: "authorization-expiry-test.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(result.statusCode, 503);
});

test("CLI 연결 관리자가 단절 뒤 같은 URL을 자동 resume한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("auto resumed"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  let reconnected!: () => void;
  const reconnectedPromise = new Promise<void>((resolve) => {
    reconnected = resolve;
  });
  const client = connectResilientTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "automatic-resume-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
    onStatus(status) {
      if (status.state === "active" && status.attempt !== undefined) reconnected();
    },
  });
  context.after(() => client.close());
  const initial = await client.ready;
  await client.disconnect();
  await Promise.race([
    reconnectedPromise,
    delay(1_000).then(() => {
      throw new Error("automatic resume timed out");
    }),
  ]);

  const result = await sendRequest({
    port: gatewayPort,
    host: "automatic-resume-test.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString(), "auto resumed");
  assert.equal(new URL(initial.shareUrl).hostname, "automatic-resume-test.localhost");
});

test("공유 URL은 내부 listener가 아니라 명시한 public content origin을 사용한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("public origin"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    contentDomain: "preview.example.com",
    publicContentOrigin: "https://preview.example.com",
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "public-origin-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());

  const active = await client.ready;
  assert.equal(active.shareUrl, "https://public-origin-test.preview.example.com/");
});

test("Origin·forwarding·Location·Cookie를 local-view 경계로 투영한다", async (context) => {
  let observedHeaders: import("node:http").IncomingHttpHeaders | undefined;
  const origin = createServer((incoming, response) => {
    observedHeaders = incoming.headers;
    const address = origin.address();
    assert.ok(address !== null && typeof address !== "string");
    response.writeHead(302, {
      location: `http://127.0.0.1:${address.port}/next?q=1`,
      refresh: `0; url=http://127.0.0.1:${address.port}/later`,
      "set-cookie": [
        "app=ok; Domain=127.0.0.1; Path=/; HttpOnly",
        "parent=blocked; Domain=example.com; Path=/",
      ],
    });
    response.end();
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "projection-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const publicOrigin = `http://projection-test.localhost:${gatewayPort}`;
  const result = await sendRequest({
    port: gatewayPort,
    host: "projection-test.localhost",
    method: "GET",
    path: "/start",
    chunks: [],
    headers: {
      origin: publicOrigin,
      referer: `${publicOrigin}/form?q=2`,
      forwarded: "for=attacker;host=evil.example",
      "x-forwarded-host": "evil.example",
    },
  });

  assert.equal(observedHeaders?.host, `127.0.0.1:${originPort}`);
  assert.equal(observedHeaders?.origin, `http://127.0.0.1:${originPort}`);
  assert.equal(observedHeaders?.referer, `http://127.0.0.1:${originPort}/form?q=2`);
  assert.equal(observedHeaders?.forwarded, undefined);
  assert.equal(observedHeaders?.["x-forwarded-host"], undefined);
  assert.equal(result.headers.location, `${publicOrigin}/next?q=1`);
  assert.equal(result.headers.refresh, `0; url=${publicOrigin}/later`);
  assert.deepEqual(result.headers["set-cookie"], ["app=ok; Path=/; HttpOnly"]);
});

test("request·finite response 크기 제한을 초과하면 명시적으로 거부한다", async (context) => {
  const origin = createServer(async (incoming, response) => {
    if (incoming.url === "/upload") {
      for await (const _chunk of incoming) {
        // The Gateway must reset this request before forwarding the oversized body.
      }
      response.end("unexpected");
      return;
    }
    response.writeHead(200, { "content-length": "5" });
    response.end("12345");
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionLimits: {
      maxRequestBodyBytes: 4,
      maxFiniteResponseBytes: 4,
    },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "size-limit-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const upload = await sendRequest({
    port: gatewayPort,
    host: "size-limit-test.localhost",
    method: "POST",
    path: "/upload",
    chunks: [Buffer.from("12345")],
  });
  assert.equal(upload.statusCode, 413);

  const download = await sendRequest({
    port: gatewayPort,
    host: "size-limit-test.localhost",
    method: "GET",
    path: "/download",
    chunks: [],
  });
  assert.equal(download.statusCode, 502);
  assert.match(download.body.toString(), /UPSTREAM_RESPONSE_TOO_LARGE/);
});

test("local response-header timeout은 502 표준 오류로 종료한다", async (context) => {
  const origin = createServer(() => {
    // Intentionally accept the request without producing response headers.
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionLimits: { responseHeaderTimeoutMs: 40 },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "header-timeout-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const result = await sendRequest({
    port: gatewayPort,
    host: "header-timeout-test.localhost",
    method: "GET",
    path: "/slow",
    chunks: [],
  });
  assert.equal(result.statusCode, 502);
  assert.match(result.body.toString(), /HEADER_TIMEOUT/);
});

test("Tunnel 동시 Stream 상한을 넘는 요청은 429로 거부한다", async (context) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const origin = createServer(async (_incoming, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: open\n\n");
    await released;
    response.end();
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionLimits: { maxConcurrentStreams: 1 },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "concurrency-limit-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const firstRequest = request({
    host: "127.0.0.1",
    port: gatewayPort,
    path: "/events",
    headers: { host: "concurrency-limit-test.localhost" },
  });
  firstRequest.end();
  const firstResponse = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => firstRequest.once("response", resolve).once("error", reject),
  );
  await onceEvent<[Buffer]>(firstResponse, "data");

  const second = await sendRequest({
    port: gatewayPort,
    host: "concurrency-limit-test.localhost",
    method: "GET",
    path: "/second",
    chunks: [],
  });
  assert.equal(second.statusCode, 429);
  assert.equal(second.headers["retry-after"], "1");
  release();
  await collect(firstResponse);
});

test("운영 kill switch가 route·열린 Stream·resume을 함께 폐기한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("visible"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "kill-switch-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  const activation = await client.ready;

  gateway.setKillSwitch(true);
  assert.equal(gateway.isKillSwitchEnabled(), true);
  await delay(10);
  const disabled = await sendRequest({
    port: gatewayPort,
    host: "kill-switch-test.localhost",
    method: "GET",
    path: "/",
    chunks: [],
  });
  assert.equal(disabled.statusCode, 503);
  assert.match(disabled.body.toString(), /SERVICE_DISABLED/);

  gateway.setKillSwitch(false);
  const rejectedResume = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "kill-switch-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
    resumeSecret: activation.resumeSecret,
  });
  context.after(() => rejectedResume.disconnect());
  await assert.rejects(
    rejectedResume.ready,
    (error: unknown) =>
      error instanceof TunnelConnectionError && error.code === "RESUME_REJECTED",
  );
  assert.match(gateway.metrics(), /event="kill_switch_changed"} 2/);
  assert.match(gateway.metrics(), /review_tunnel_active_tunnels 0/);
});

test("metrics endpoint는 별도 bearer token으로만 읽을 수 있다", async (context) => {
  const metricsToken = "metrics-token-".padEnd(40, "x");
  const gateway = createGatewayServer({
    controlHost: "control.localhost",
    metricsBearerToken: metricsToken,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const denied = await sendRequest({
    port: gatewayPort,
    host: "control.localhost",
    method: "GET",
    path: "/metrics",
    chunks: [],
  });
  assert.equal(denied.statusCode, 401);
  const allowed = await sendRequest({
    port: gatewayPort,
    host: "control.localhost",
    method: "GET",
    path: "/metrics",
    chunks: [],
    headers: { authorization: `Bearer ${metricsToken}` },
  });
  assert.equal(allowed.statusCode, 200);
  assert.match(allowed.body.toString(), /review_tunnel_active_tunnels/);
  assert.doesNotMatch(allowed.body.toString(), new RegExp(metricsToken));
});

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

test("종료된 Stream의 늦은 WINDOW_UPDATE가 Carrier를 끊지 않는다", async (context) => {
  const origin = createServer((_incoming, response) => {
    response.writeHead(200, {
      "content-type": "application/javascript",
      "content-length": "2048",
    });
    response.end(Buffer.alloc(2048, 97));
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));

  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "late-window-update-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const results = await Promise.all(
    Array.from({ length: 16 }, (_, index) => sendRequest({
      port: gatewayPort,
      host: "late-window-update-test.localhost",
      method: "GET",
      path: `/asset-${index}.js`,
      chunks: [],
    })),
  );
  assert.ok(results.every((result) => result.statusCode === 200));
  await delay(20);
  const final = await sendRequest({
    port: gatewayPort,
    host: "late-window-update-test.localhost",
    method: "GET",
    path: "/still-connected.js",
    chunks: [],
  });
  assert.equal(final.statusCode, 200);
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

test("resume probe 도중 후보가 끊겨도 다음 generation이 같은 URL을 복구한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("resumed after candidate loss"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({ activationTimeoutMs: 300 });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`;

  const initialClient = connectTunnelClient({
    gatewayUrl,
    tunnelId: "resume-candidate-loss",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  const initial = await initialClient.ready;
  await initialClient.disconnect();
  await delay(10);

  const interrupted = new WebSocket(gatewayUrl, CARRIER_PROFILE);
  await onceEvent(interrupted, "open");
  interrupted.send(encodeEnvelope({
    type: FrameType.Hello,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: encodeMetadata({
      mode: "resume",
      tunnelId: initial.tunnelId,
      resumeSecret: initial.resumeSecret,
      localOriginFingerprint: createHash("sha256")
        .update("review-tunnel.v1.local-origin\0", "utf8")
        .update(`http://127.0.0.1:${originPort}`, "utf8")
        .digest("base64url"),
      originProjection: "local-view",
    }),
  }));
  const configEnvelope = await nextCarrierEnvelope(interrupted, FrameType.SessionConfig);
  const config = decodeSessionConfigMetadata(configEnvelope.payload);
  const probeStarted = nextCarrierEnvelope(interrupted, FrameType.OpenProbe);
  interrupted.send(encodeEnvelope({
    type: FrameType.ConfigApplied,
    flags: 0,
    generation: configEnvelope.generation,
    streamId: 0,
    payload: encodeMetadata({
      revision: config.revision,
      digest: config.digest,
      result: "APPLIED",
      localOriginReady: true,
    }),
  }));
  await probeStarted;
  interrupted.terminate();
  await onceEvent(interrupted, "close");
  await delay(10);

  const recovered = connectTunnelClient({
    gatewayUrl,
    tunnelId: initial.tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    resumeSecret: initial.resumeSecret,
  });
  context.after(() => recovered.close());
  const activation = await recovered.ready;
  assert.equal(activation.generation, 3);
  assert.equal(activation.shareUrl, initial.shareUrl);
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

function nextCarrierEnvelope(
  socket: WebSocket,
  expectedType: number,
): Promise<ReturnType<typeof decodeEnvelope>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: import("ws").RawData, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const envelope = decodeEnvelope(bytes);
        if (envelope.type !== expectedType) return;
        cleanup();
        resolve(envelope);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
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
  headers?: Readonly<Record<string, string>>;
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
      ...input.headers,
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

async function rawHttp(port: number, payload: string): Promise<string> {
  const socket = connectTcp({ host: "127.0.0.1", port });
  socket.end(payload);
  return (await collect(socket)).toString("utf8");
}
