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
  decodeSessionProvisionedMetadata,
  decodeSessionConfigMetadata,
  encodeEnvelope,
  encodeMetadata,
  encodeWindowUpdate,
  FrameType,
} from "../../../packages/protocol/src/index.ts";
import {
  INITIAL_CONNECTION_WINDOW_BYTES,
  INITIAL_STREAM_WINDOW_BYTES,
} from "../../../packages/relay/src/index.ts";
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

test("Carrier는 정확한 review-tunnel subprotocol이 없으면 upgrade 전에 거부한다", async (context) => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  for (const protocols of [undefined, [CARRIER_PROFILE, "unexpected"]] as const) {
    const socket = protocols === undefined
      ? new WebSocket(`ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`)
      : new WebSocket(
          `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
          [...protocols],
        );
    context.after(() => socket.terminate());
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => reject(new Error("unsupported Carrier profile was accepted")));
      socket.once("error", () => undefined);
    });
    assert.equal(status, 426);
  }
});

test("Carrier WebSocket은 protocol envelope 최대 크기를 초과한 message를 조립하지 않는다", async (context) => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const socket = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => socket.terminate());
  await onceEvent(socket, "open");
  socket.send(Buffer.alloc(65_552));
  const [code] = await onceEvent<[number]>(socket, "close");
  assert.equal(code, 1009);
});

test("Carrier는 WebSocket control ping/pong을 protocol error로 닫는다", async (context) => {
  for (const controlFrame of ["ping", "pong"] as const) {
    await context.test(controlFrame, async (subcontext) => {
      const gateway = createGatewayServer();
      const gatewayPort = await gateway.listen();
      subcontext.after(() => gateway.close());
      const socket = new WebSocket(
        `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
        CARRIER_PROFILE,
      );
      subcontext.after(() => socket.terminate());
      await onceEvent(socket, "open");
      const closed = onceEvent<[number]>(socket, "close");
      let automaticPongs = 0;
      socket.on("pong", () => {
        automaticPongs += 1;
      });

      if (controlFrame === "ping") socket.ping(Buffer.from("not-envelope-heartbeat"));
      else socket.pong(Buffer.from("not-envelope-heartbeat"));

      assert.equal(await Promise.race([
        closed.then(([code]) => code),
        delay(1_000, undefined, { ref: false }).then(() => 0),
      ]), 1002);
      if (controlFrame === "ping") assert.equal(automaticPongs, 0);
    });
  }
});

test("activation과 ACTIVE Carrier의 처리 대기 frame queue는 고정 상한을 넘으면 닫힌다", async (context) => {
  const activationGateway = createGatewayServer({ maxPendingCarrierFrames: 1 });
  const activationPort = await activationGateway.listen();
  context.after(() => activationGateway.close());
  const activating = new WebSocket(
    `ws://127.0.0.1:${activationPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => activating.terminate());
  await onceEvent(activating, "open");
  const activationClosed = onceEvent<[number]>(activating, "close");
  const activationTransport = webSocketTransport(activating);
  activationTransport.cork();
  activating.send(encodeEnvelope({
    type: FrameType.Hello,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: encodeMetadata({
      mode: "create",
      tunnelId: "activation-frame-budget",
      localOriginFingerprint: "A".repeat(43),
      originProjection: "local-view",
    }),
  }));
  activating.send(encodeEnvelope({
    type: FrameType.Ping,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: new Uint8Array(),
  }));
  activationTransport.uncork();
  assert.equal((await activationClosed)[0], 1009);

  const activeGateway = createGatewayServer({ maxPendingCarrierFrames: 2 });
  const activePort = await activeGateway.listen();
  context.after(() => activeGateway.close());
  const active = new WebSocket(
    `ws://127.0.0.1:${activePort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => active.terminate());
  await onceEvent(active, "open");
  const activation = await activateManualCarrier(active, "active-frame-budget");
  const activeClosed = onceEvent<[number]>(active, "close");
  const activeTransport = webSocketTransport(active);
  activeTransport.cork();
  for (let index = 0; index < 3; index += 1) {
    active.send(encodeEnvelope({
      type: FrameType.Ping,
      flags: 0,
      generation: activation.generation,
      streamId: 0,
      payload: new Uint8Array(),
    }));
  }
  activeTransport.uncork();
  assert.equal((await activeClosed)[0], 1009);
});

test("HELLO 전 Carrier connection도 global pending Tunnel quota에 포함한다", async (context) => {
  const gateway = createGatewayServer({ maxPendingTunnels: 1 });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const first = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => first.terminate());
  await onceEvent(first, "open");

  const second = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => second.terminate());
  const status = await new Promise<number>((resolve, reject) => {
    second.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    second.once("open", () => reject(new Error("pending Carrier quota was bypassed")));
    second.once("error", () => undefined);
  });
  assert.equal(status, 429);
});

test("CREATING Session과 HELLO 대기 Carrier는 하나의 pending quota를 공유한다", async (context) => {
  const gateway = createGatewayServer({ maxPendingTunnels: 1 });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const creating = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => creating.terminate());
  await onceEvent(creating, "open");
  const provisioned = nextCarrierEnvelope(creating, FrameType.SessionProvisioned);
  creating.send(encodeEnvelope({
    type: FrameType.Hello,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: encodeMetadata({
      mode: "create",
      tunnelId: "creating-pending-quota",
      localOriginFingerprint: "A".repeat(43),
      originProjection: "local-view",
    }),
  }));
  await provisioned;

  const waiting = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => waiting.terminate());
  const status = await unexpectedResponseStatus(waiting);
  assert.equal(status, 429);
});

test("동일한 create CONFIG_APPLIED 재전송은 프로비저닝을 실패시키지 않는다", async (context) => {
  const gateway = createGatewayServer({ activationTimeoutMs: 500 });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const socket = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => socket.terminate());
  await onceEvent(socket, "open");

  const provisionedReceived = nextCarrierEnvelope(socket, FrameType.SessionProvisioned);
  const configReceived = nextCarrierEnvelope(socket, FrameType.SessionConfig);
  socket.send(encodeEnvelope({
    type: FrameType.Hello,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: encodeMetadata({
      mode: "create",
      tunnelId: "duplicate-config-applied",
      localOriginFingerprint: "A".repeat(43),
      originProjection: "local-view",
    }),
  }));
  const provisionedEnvelope = await provisionedReceived;
  const provisioned = decodeSessionProvisionedMetadata(provisionedEnvelope.payload);
  const configEnvelope = await configReceived;
  const config = decodeSessionConfigMetadata(configEnvelope.payload);
  const applied = encodeEnvelope({
    type: FrameType.ConfigApplied,
    flags: 0,
    generation: configEnvelope.generation,
    streamId: 0,
    payload: encodeMetadata({
      revision: config.revision,
      digest: config.digest,
      result: "APPLIED",
      localOriginReady: true,
      provisionReceipt: provisioned.provisionId,
    }),
  });
  const probeOpened = nextCarrierEnvelope(socket, FrameType.OpenProbe);
  const probeDataReceived = nextCarrierEnvelope(socket, FrameType.Data);
  const probeEnded = nextCarrierEnvelope(socket, FrameType.EndStream);
  socket.send(applied);
  socket.send(applied);
  const probe = await probeOpened;
  const probeData = await probeDataReceived;
  await probeEnded;
  const active = nextCarrierEnvelope(socket, FrameType.SessionActive);
  socket.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: probe.generation,
    streamId: probe.streamId,
    payload: probeData.payload,
  }));
  socket.send(encodeEnvelope({
    type: FrameType.EndStream,
    flags: 0,
    generation: probe.generation,
    streamId: probe.streamId,
    payload: new Uint8Array(),
  }));
  await active;
  socket.send(applied);
  await Promise.race([
    onceEvent(socket, "close").then(() => {
      throw new Error("identical CONFIG_APPLIED retry closed the Carrier");
    }),
    delay(50),
  ]);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("browser WebSocket 취소 뒤 이미-flight client continuation은 stream 단위로 무시한다", async (context) => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => carrier.terminate());
  await onceEvent(carrier, "open");
  const activation = await activateManualCarrier(carrier, "late-client-continuation");

  const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
  const reset = nextCarrierEnvelope(carrier, FrameType.ResetStream);
  const reviewer = connectTcp(gatewayPort, "127.0.0.1");
  reviewer.on("error", () => undefined);
  context.after(() => reviewer.destroy());
  reviewer.write(
    "GET /cancel HTTP/1.1\r\n" +
    "Host: late-client-continuation.localhost\r\n" +
    "Connection: Upgrade\r\n" +
    "Upgrade: websocket\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  const streamId = (await Promise.race([
    opened,
    delay(1_000, undefined, { ref: false }).then(() => {
      throw new Error("cancelled reviewer stream was not opened");
    }),
  ])).streamId;
  const reviewerClosed = onceEvent(reviewer, "close");
  reviewer.resetAndDestroy();
  await reviewerClosed;
  assert.equal((await Promise.race([
    reset,
    delay(1_000, undefined, { ref: false }).then(() => {
      throw new Error("cancelled reviewer stream did not emit RESET");
    }),
  ])).streamId, streamId);

  for (const [type, payload] of [
    [FrameType.ResponseHeaders, encodeMetadata({
      statusCode: 101,
      statusMessage: "Switching Protocols",
      headers: [["upgrade", "websocket"]],
    })],
    [FrameType.Data, Uint8Array.of(1)],
    [FrameType.EndStream, new Uint8Array()],
    [FrameType.ResetStream, encodeMetadata({ code: "ALREADY_IN_FLIGHT" })],
    [FrameType.WindowUpdate, encodeWindowUpdate(1)],
  ] as const) {
    carrier.send(encodeEnvelope({
      type,
      flags: 0,
      generation: activation.generation,
      streamId,
      payload,
    }));
  }
  const pong = nextCarrierEnvelope(carrier, FrameType.Pong);
  carrier.send(encodeEnvelope({
    type: FrameType.Ping,
    flags: 0,
    generation: activation.generation,
    streamId: 0,
    payload: new Uint8Array(),
  }));
  await pong;

  const closed = onceEvent<[number]>(carrier, "close");
  carrier.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: activation.generation,
    streamId: streamId + 2,
    payload: Uint8Array.of(1),
  }));
  assert.equal((await closed)[0], 1002);
});

test("ambiguous WebSocket OpenHttp send 실패는 captured Carrier stream을 RESET한다", async () => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  const reviewer = connectTcp(gatewayPort, "127.0.0.1");
  reviewer.on("error", () => undefined);
  const originalSend = WebSocket.prototype.send;

  try {
    await onceEvent(carrier, "open");
    await activateManualCarrier(carrier, "ambiguous-open-reset");
    let failedOpen = false;
    WebSocket.prototype.send = function patchedSend(
      this: WebSocket,
      data: never,
      ...arguments_: never[]
    ) {
      try {
        const envelope = decodeEnvelope(Buffer.from(data));
        const callback = arguments_.at(-1);
        if (
          !failedOpen &&
          envelope.type === FrameType.OpenHttp &&
          typeof callback === "function"
        ) {
          failedOpen = true;
          Reflect.apply(originalSend, this, [data]);
          (callback as (error?: Error) => void)(new Error("ambiguous OpenHttp failure"));
          return;
        }
      } catch {
        // Non-Carrier bytes use the original WebSocket implementation.
      }
      Reflect.apply(originalSend, this, [data, ...arguments_]);
    } as typeof WebSocket.prototype.send;

    const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
    const reset = nextCarrierEnvelope(carrier, FrameType.ResetStream);
    reviewer.write(
      "GET /socket HTTP/1.1\r\n" +
      "Host: ambiguous-open-reset.localhost\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const streamId = (await opened).streamId;
    const resetEnvelope = await Promise.race([
      reset,
      delay(1_000, undefined, { ref: false }).then(() => {
        throw new Error("ambiguous OpenHttp failure did not emit RESET");
      }),
    ]);
    assert.equal(resetEnvelope.streamId, streamId);
  } finally {
    WebSocket.prototype.send = originalSend;
    reviewer.destroy();
    carrier.terminate();
    await gateway.close();
  }
});

test("browser WebSocket forwarding 실패는 captured Carrier에 RESET을 보낸다", async () => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  let reviewer: ReturnType<typeof connectTcp> | undefined;
  const originalSend = WebSocket.prototype.send;

  try {
    await onceEvent(carrier, "open");
    const activation = await activateManualCarrier(carrier, "raw-forward-reset");
    const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
    reviewer = connectTcp(gatewayPort, "127.0.0.1");
    reviewer.on("error", () => undefined);
    reviewer.write(
      "GET /socket HTTP/1.1\r\n" +
      "Host: raw-forward-reset.localhost\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const streamId = (await opened).streamId;
    carrier.send(encodeEnvelope({
      type: FrameType.ResponseHeaders,
      flags: 0,
      generation: activation.generation,
      streamId,
      payload: encodeMetadata({
        statusCode: 101,
        statusMessage: "Switching Protocols",
        headers: [
          ["connection", "Upgrade"],
          ["upgrade", "websocket"],
        ],
      }),
    }));
    await onceEvent(reviewer, "data");

    let failed = false;
    WebSocket.prototype.send = function patchedSend(
      this: WebSocket,
      data: never,
      ...arguments_: never[]
    ) {
      try {
        const envelope = decodeEnvelope(Buffer.from(data));
        const callback = arguments_.at(-1);
        if (
          !failed &&
          envelope.type === FrameType.Data &&
          envelope.streamId === streamId &&
          typeof callback === "function"
        ) {
          failed = true;
          (callback as (error?: Error) => void)(new Error("injected raw forward failure"));
          return;
        }
      } catch {
        // Browser application frames are not Carrier envelopes.
      }
      Reflect.apply(originalSend, this, [data, ...arguments_]);
    } as typeof WebSocket.prototype.send;

    const reset = nextCarrierEnvelope(carrier, FrameType.ResetStream);
    reviewer.write(Buffer.from([1, 2, 3]));
    const resetEnvelope = await Promise.race([
      reset,
      delay(1_000, undefined, { ref: false }).then(() => {
        throw new Error("raw forwarding failure did not emit RESET");
      }),
    ]);
    assert.equal(resetEnvelope.streamId, streamId);

    const pong = nextCarrierEnvelope(carrier, FrameType.Pong);
    carrier.send(encodeEnvelope({
      type: FrameType.Ping,
      flags: 0,
      generation: activation.generation,
      streamId: 0,
      payload: new Uint8Array(),
    }));
    await pong;
  } finally {
    WebSocket.prototype.send = originalSend;
    reviewer?.destroy();
    carrier.terminate();
    await gateway.close();
  }
});

test("captured Carrier에 RESET 전송이 실패하면 해당 Carrier를 fail-close한다", async () => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  const reviewer = connectTcp(gatewayPort, "127.0.0.1");
  reviewer.on("error", () => undefined);
  const originalSend = WebSocket.prototype.send;

  try {
    await onceEvent(carrier, "open");
    const activation = await activateManualCarrier(carrier, "reset-fail-close");
    const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
    reviewer.write(
      "GET /socket HTTP/1.1\r\n" +
      "Host: reset-fail-close.localhost\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const streamId = (await opened).streamId;
    carrier.send(encodeEnvelope({
      type: FrameType.ResponseHeaders,
      flags: 0,
      generation: activation.generation,
      streamId,
      payload: encodeMetadata({
        statusCode: 101,
        statusMessage: "Switching Protocols",
        headers: [["upgrade", "websocket"]],
      }),
    }));
    await onceEvent(reviewer, "data");

    let failedData = false;
    WebSocket.prototype.send = function patchedSend(
      this: WebSocket,
      data: never,
      ...arguments_: never[]
    ) {
      try {
        const envelope = decodeEnvelope(Buffer.from(data));
        const callback = arguments_.at(-1);
        if (
          !failedData &&
          envelope.type === FrameType.Data &&
          envelope.streamId === streamId &&
          typeof callback === "function"
        ) {
          failedData = true;
          (callback as (error?: Error) => void)(new Error("injected forwarding failure"));
          return;
        }
        if (
          envelope.type === FrameType.ResetStream &&
          envelope.streamId === streamId &&
          typeof callback === "function"
        ) {
          (callback as (error?: Error) => void)(new Error("injected RESET failure"));
          return;
        }
      } catch {
        // WebSocket control frames are not Carrier envelopes.
      }
      Reflect.apply(originalSend, this, [data, ...arguments_]);
    } as typeof WebSocket.prototype.send;

    const closed = onceEvent<[number]>(carrier, "close");
    reviewer.write(Buffer.from([4, 5, 6]));
    const [code] = await Promise.race([
      closed,
      delay(1_000, undefined, { ref: false }).then(() => {
        throw new Error("RESET failure did not close captured Carrier");
      }),
    ]);
    assert.equal(code, 1011);
  } finally {
    WebSocket.prototype.send = originalSend;
    reviewer.destroy();
    carrier.terminate();
    await gateway.close();
  }
});

test("retired DATA는 local-reset 당시 connection credit까지만 허용한다", async (context) => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => carrier.terminate());
  await onceEvent(carrier, "open");
  const activation = await activateManualCarrier(carrier, "bounded-late-client-data");

  const retiredStreamIds: number[] = [];
  for (let index = 0; index < INITIAL_CONNECTION_WINDOW_BYTES / INITIAL_STREAM_WINDOW_BYTES; index += 1) {
    const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
    const reset = nextCarrierEnvelope(carrier, FrameType.ResetStream);
    const reviewer = connectTcp(gatewayPort, "127.0.0.1");
    reviewer.on("error", () => undefined);
    context.after(() => reviewer.destroy());
    reviewer.write(
      `GET /cancel-${index} HTTP/1.1\r\n` +
      "Host: bounded-late-client-data.localhost\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const streamId = (await opened).streamId;
    const reviewerClosed = onceEvent(reviewer, "close");
    reviewer.resetAndDestroy();
    await reviewerClosed;
    assert.equal((await reset).streamId, streamId);
    retiredStreamIds.push(streamId);
  }

  for (const streamId of retiredStreamIds) {
    carrier.send(encodeEnvelope({
      type: FrameType.Data,
      flags: 0,
      generation: activation.generation,
      streamId,
      payload: new Uint8Array(INITIAL_STREAM_WINDOW_BYTES - 1),
    }));
    carrier.send(encodeEnvelope({
      type: FrameType.Data,
      flags: 0,
      generation: activation.generation,
      streamId,
      payload: Uint8Array.of(1),
    }));
  }
  const pong = nextCarrierEnvelope(carrier, FrameType.Pong);
  carrier.send(encodeEnvelope({
    type: FrameType.Ping,
    flags: 0,
    generation: activation.generation,
    streamId: 0,
    payload: new Uint8Array(),
  }));
  await pong;

  const closed = onceEvent<[number]>(carrier, "close");
  carrier.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: activation.generation,
    streamId: retiredStreamIds[0] as number,
    payload: Uint8Array.of(1),
  }));
  assert.equal(await Promise.race([
    closed.then(([code]) => code),
    delay(1_000, undefined, { ref: false }).then(() => 0),
  ]), 1002);
});

test("finite-response 초과를 일으킨 DATA도 retired receive allowance를 소비한다", async (context) => {
  const gateway = createGatewayServer({
    sessionLimits: { maxFiniteResponseBytes: 1 },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => carrier.terminate());
  await onceEvent(carrier, "open");
  const activation = await activateManualCarrier(carrier, "finite-overrun-credit");

  const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
  const reset = nextCarrierEnvelope(carrier, FrameType.ResetStream);
  const reviewer = request({
    host: "127.0.0.1",
    port: gatewayPort,
    path: "/finite",
    headers: { host: "finite-overrun-credit.localhost" },
  });
  reviewer.on("error", () => undefined);
  context.after(() => reviewer.destroy());
  reviewer.end();
  const streamId = (await opened).streamId;
  carrier.send(encodeEnvelope({
    type: FrameType.ResponseHeaders,
    flags: 0,
    generation: activation.generation,
    streamId,
    payload: encodeMetadata({
      statusCode: 200,
      statusMessage: "OK",
      headers: [["content-type", "text/plain"]],
    }),
  }));
  carrier.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: activation.generation,
    streamId,
    payload: Uint8Array.of(1, 2),
  }));
  assert.equal((await reset).streamId, streamId);

  const closed = onceEvent<[number]>(carrier, "close");
  carrier.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: activation.generation,
    streamId,
    payload: new Uint8Array(INITIAL_STREAM_WINDOW_BYTES - 1),
  }));
  assert.equal(await Promise.race([
    closed.then(([code]) => code),
    delay(1_000, undefined, { ref: false }).then(() => 0),
  ]), 1002);
});

test("header로만 선언된 finite-response 초과는 미수신 DATA allowance를 차감하지 않는다", async (context) => {
  const gateway = createGatewayServer({
    sessionLimits: { maxFiniteResponseBytes: 1 },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => carrier.terminate());
  await onceEvent(carrier, "open");
  const activation = await activateManualCarrier(carrier, "declared-overrun-credit");

  const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
  const reset = nextCarrierEnvelope(carrier, FrameType.ResetStream);
  const reviewer = request({
    host: "127.0.0.1",
    port: gatewayPort,
    path: "/declared-finite",
    headers: { host: "declared-overrun-credit.localhost" },
  });
  reviewer.on("error", () => undefined);
  context.after(() => reviewer.destroy());
  reviewer.end();
  const streamId = (await opened).streamId;
  carrier.send(encodeEnvelope({
    type: FrameType.ResponseHeaders,
    flags: 0,
    generation: activation.generation,
    streamId,
    payload: encodeMetadata({
      statusCode: 200,
      statusMessage: "OK",
      headers: [
        ["content-type", "text/plain"],
        ["content-length", "2"],
      ],
    }),
  }));
  assert.equal((await reset).streamId, streamId);

  carrier.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: activation.generation,
    streamId,
    payload: new Uint8Array(INITIAL_STREAM_WINDOW_BYTES - 1),
  }));
  carrier.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: activation.generation,
    streamId,
    payload: Uint8Array.of(1),
  }));
  const pong = nextCarrierEnvelope(carrier, FrameType.Pong);
  carrier.send(encodeEnvelope({
    type: FrameType.Ping,
    flags: 0,
    generation: activation.generation,
    streamId: 0,
    payload: new Uint8Array(),
  }));
  await pong;
});

test("retired stream의 malformed/empty continuation은 계속 Carrier를 fail-close한다", async (context) => {
  const malformedFrames = [
    { type: FrameType.ResponseHeaders, payload: encodeMetadata({ statusCode: 200 }) },
    { type: FrameType.Data, payload: new Uint8Array() },
    { type: FrameType.ResetStream, payload: encodeMetadata({ code: "" }) },
    { type: FrameType.WindowUpdate, payload: Uint8Array.of(1) },
  ] as const;

  for (const [index, malformed] of malformedFrames.entries()) {
    await context.test(`malformed continuation ${index + 1}`, async (subcontext) => {
      const gateway = createGatewayServer();
      const gatewayPort = await gateway.listen();
      subcontext.after(() => gateway.close());
      const carrier = new WebSocket(
        `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
        CARRIER_PROFILE,
      );
      subcontext.after(() => carrier.terminate());
      await onceEvent(carrier, "open");
      const activation = await activateManualCarrier(carrier, `malformed-late-${index}`);
      const closed = onceEvent<[number]>(carrier, "close");
      carrier.send(encodeEnvelope({
        type: malformed.type,
        flags: 0,
        generation: activation.generation,
        streamId: activation.probeStreamId,
        payload: malformed.payload,
      }));
      assert.equal((await closed)[0], 1002);
    });
  }
});

test("active stream의 outstanding을 초과한 WINDOW_UPDATE는 계속 Carrier를 fail-close한다", async (context) => {
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const carrier = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
  );
  context.after(() => carrier.terminate());
  await onceEvent(carrier, "open");
  const activation = await activateManualCarrier(carrier, "invalid-flow-update");

  const opened = nextCarrierEnvelope(carrier, FrameType.OpenHttp);
  const reviewer = request({
    host: "127.0.0.1",
    port: gatewayPort,
    path: "/flow",
    headers: { host: "invalid-flow-update.localhost" },
  });
  reviewer.on("error", () => undefined);
  context.after(() => reviewer.destroy());
  reviewer.end();
  const streamId = (await opened).streamId;
  const closed = onceEvent<[number]>(carrier, "close");
  carrier.send(encodeEnvelope({
    type: FrameType.WindowUpdate,
    flags: 0,
    generation: activation.generation,
    streamId,
    payload: encodeWindowUpdate(1),
  }));
  assert.equal((await closed)[0], 1002);
});

test("전역 active Tunnel quota는 다음 Carrier를 activation 전에 거부한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("active"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({ maxActiveTunnels: 1 });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`;
  const first = connectTunnelClient({
    gatewayUrl,
    tunnelId: "quota-active-one",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => first.close());
  await first.ready;

  const second = connectTunnelClient({
    gatewayUrl,
    tunnelId: "quota-active-two",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => second.disconnect());
  await assert.rejects(second.ready);
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
    maxCanaryWebSockets: 1,
    canaryWebSocketIdleTimeoutMs: 30,
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
  assert.equal(socket.readyState, WebSocket.OPEN);
  const overCapacity = new WebSocket(`ws://127.0.0.1:${gatewayPort}/websocket`, {
    headers: {
      host: "canary.localhost",
      authorization: `Bearer ${token}`,
    },
  });
  context.after(() => overCapacity.terminate());
  assert.equal(await unexpectedResponseStatus(overCapacity), 429);
  const [idleCode] = await onceEvent<[number]>(socket, "close");
  assert.equal(idleCode, 1008);
});

test("authenticated canary echo는 paused peer의 중복 in-flight message를 fail-close한다", async (context) => {
  const token = "bounded-canary-token-that-is-at-least-32-bytes";
  const gateway = createGatewayServer({
    canaryHost: "canary.localhost",
    canaryBearerToken: token,
    maxCanaryWebSockets: 1,
    canaryWebSocketIdleTimeoutMs: 1_000,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const headers = {
    host: "canary.localhost",
    authorization: `Bearer ${token}`,
  };
  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/websocket`, { headers });
  socket.on("error", () => undefined);
  context.after(() => socket.terminate());
  await onceEvent(socket, "open");
  const closed = new Promise<number>((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
  const transport = webSocketTransport(socket);
  transport.pause();
  transport.cork();
  socket.send(Buffer.alloc(64 * 1024));
  socket.send(Buffer.from("second-in-flight-message"));
  transport.uncork();
  await delay(20);
  transport.resume();

  assert.equal(await Promise.race([
    closed,
    delay(1_000).then(() => {
      throw new Error("canary echo backpressure did not close the peer");
    }),
  ]), 1006);

  const replacement = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/websocket`,
    { headers },
  );
  context.after(() => replacement.terminate());
  await onceEvent(replacement, "open");
  const echoed = onceEvent<[Buffer, boolean]>(replacement, "message");
  replacement.send(Buffer.from("bounded-normal-echo"));
  const [message, isBinary] = await echoed;
  assert.equal(isBinary, true);
  assert.equal(message.toString(), "bounded-normal-echo");
});

test("authenticated canary는 paused peer의 control ping flood를 fail-close한다", async (context) => {
  const token = "ping-bounded-canary-token-that-is-at-least-32-bytes";
  const gateway = createGatewayServer({
    canaryHost: "canary.localhost",
    canaryBearerToken: token,
    maxCanaryWebSockets: 1,
    canaryWebSocketIdleTimeoutMs: 1_000,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const headers = {
    host: "canary.localhost",
    authorization: `Bearer ${token}`,
  };
  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/websocket`, { headers });
  socket.on("error", () => undefined);
  context.after(() => socket.terminate());
  await onceEvent(socket, "open");
  let pongCount = 0;
  socket.on("pong", () => {
    pongCount += 1;
  });
  const closed = new Promise<number>((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
  const transport = webSocketTransport(socket);
  transport.pause();
  transport.cork();
  socket.ping(Buffer.alloc(125));
  socket.ping(Buffer.alloc(125));
  transport.uncork();
  await delay(20);
  transport.resume();

  assert.equal(await Promise.race([
    closed,
    delay(1_000).then(() => {
      throw new Error("canary control ping flood did not close the peer");
    }),
  ]), 1006);
  assert.equal(pongCount, 0);

  const replacement = new WebSocket(
    `ws://127.0.0.1:${gatewayPort}/websocket`,
    { headers },
  );
  context.after(() => replacement.terminate());
  await onceEvent(replacement, "open");
  const echoed = onceEvent<[Buffer, boolean]>(replacement, "message");
  replacement.send(Buffer.from("normal-echo-after-ping-flood"));
  const [message, isBinary] = await echoed;
  assert.equal(isBinary, true);
  assert.equal(message.toString(), "normal-echo-after-ping-flood");
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

test("Content-Length 없는 일반 응답은 chunked여도 finite response 상한을 적용한다", async (context) => {
  const origin = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("123");
    response.end("45");
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionLimits: { maxFiniteResponseBytes: 4 },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "chunked-size-limit-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  await assert.rejects(sendRequest({
    port: gatewayPort,
    host: "chunked-size-limit-test.localhost",
    method: "GET",
    path: "/download",
    chunks: [],
  }));
});

test("HEAD의 representation Content-Length는 본문 크기로 거부하지 않는다", async (context) => {
  const origin = createServer((_incoming, response) => {
    response.writeHead(200, { "content-length": "1000" });
    response.end();
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const gateway = createGatewayServer({
    sessionLimits: { maxFiniteResponseBytes: 4 },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "head-representation-size-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const result = await sendRequest({
    port: gatewayPort,
    host: "head-representation-size-test.localhost",
    method: "HEAD",
    path: "/resource",
    chunks: [],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.byteLength, 0);
  assert.equal(result.headers["content-length"], "1000");
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

test("terminal·Carrier loss·kill switch는 끝나지 않은 HTTP upload input도 즉시 닫는다", async () => {
  for (const mode of ["TERMINAL", "CARRIER_LOST", "KILL_SWITCH"] as const) {
    const modeId = mode.toLowerCase().replaceAll("_", "-");
    let originReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      originReceived = resolve;
    });
    const origin = createServer((incoming) => {
      incoming.once("data", originReceived);
    });
    const originPort = await listen(origin);
    const protocolErrors: string[] = [];
    const gateway = createGatewayServer({
      logger(event) {
        if (event.event === "carrier.protocol_error") {
          protocolErrors.push(event.reason ?? "unknown");
        }
      },
    });
    const gatewayPort = await gateway.listen();
    const client = connectTunnelClient({
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId: `unfinished-upload-${modeId}`,
      localOrigin: `http://127.0.0.1:${originPort}`,
    });
    let upload: ReturnType<typeof request> | undefined;
    try {
      try {
        await client.ready;
      } catch (error) {
        throw new Error(`${mode} activation failed: ${String(error)}; ${protocolErrors.join(";")}`);
      }
      upload = request({
        host: "127.0.0.1",
        port: gatewayPort,
        method: "POST",
        path: "/unfinished",
        headers: {
          host: `unfinished-upload-${modeId}.localhost`,
          "content-type": "application/octet-stream",
        },
      });
      upload.on("response", (incoming) => incoming.resume());
      const uploadClosed = new Promise<void>((resolve) => {
        upload?.once("close", resolve);
        upload?.once("error", () => resolve());
      });
      upload.write("partial-body");
      await received;

      try {
        if (mode === "TERMINAL") await client.close();
        else if (mode === "CARRIER_LOST") await client.disconnect();
        else gateway.setKillSwitch(true);
      } catch (error) {
        throw new Error(`${mode}: ${String(error)}; ${protocolErrors.join(";")}`);
      }

      await Promise.race([
        uploadClosed,
        delay(500).then(() => {
          throw new Error(`${mode} left reviewer upload input open`);
        }),
      ]);
      assert.ok(upload.socket === null || upload.socket.destroyed);
    } finally {
      upload?.destroy();
      await client.disconnect().catch(() => undefined);
      await gateway.close();
      await close(origin);
    }
  }
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

  const events: string[] = [];
  const gateway = createGatewayServer({
    logger(event) {
      if (event.reason !== undefined) events.push(`${event.event}:${event.reason}`);
    },
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "late-window-update-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.close());
  await client.ready;

  const settled = await Promise.allSettled(
    Array.from({ length: 16 }, (_, index) => sendRequest({
      port: gatewayPort,
      host: "late-window-update-test.localhost",
      method: "GET",
      path: `/asset-${index}.js`,
      chunks: [],
    })),
  );
  assert.ok(
    settled.every((result) => result.status === "fulfilled"),
    `requests rejected: ${settled.map((result) => result.status === "rejected" ? String(result.reason) : "ok").join(",")}; ${events.join(";")}`,
  );
  const results = settled.map((result) => result.value);
  assert.ok(
    results.every((result) => result.statusCode === 200),
    `unexpected statuses: ${results.map((result) => result.statusCode).join(",")}; ${events.join(";")}`,
  );
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

test("WebSocket pending head 전송 중 browser cancel은 Carrier protocol error로 승격하지 않는다", async () => {
  const originalSend = WebSocket.prototype.send;
  let releasePendingHead: ((error?: Error) => void) | undefined;
  let markPendingHeadStarted!: () => void;
  const pendingHeadStarted = new Promise<void>((resolve) => {
    markPendingHeadStarted = resolve;
  });
  WebSocket.prototype.send = function patchedSend(
    this: WebSocket,
    data: never,
    ...arguments_: never[]
  ) {
    try {
      const envelope = decodeEnvelope(Buffer.from(data));
      const callback = arguments_.at(-1);
      if (
        envelope.type === FrameType.Data &&
        envelope.streamId === 3 &&
        releasePendingHead === undefined &&
        typeof callback === "function"
      ) {
        releasePendingHead = callback as (error?: Error) => void;
        markPendingHeadStarted();
        return;
      }
    } catch {
      // Non-Carrier bytes use the original WebSocket implementation.
    }
    Reflect.apply(originalSend, this, [data, ...arguments_]);
  } as typeof WebSocket.prototype.send;

  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  const originSockets = new Set<import("node:net").Socket>();
  const origin = createServer((_incoming, response) => response.end("carrier-alive"));
  origin.on("connection", (socket) => {
    originSockets.add(socket);
    socket.once("close", () => originSockets.delete(socket));
  });
  origin.on("upgrade", (_request, socket) => {
    socket.on("error", () => undefined);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  const originPort = await listen(origin);
  const gateway = createGatewayServer({ heartbeatIntervalMs: 1_000 });
  const gatewayPort = await gateway.listen();
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "pending-head-cancel",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  let browser: ReturnType<typeof connectTcp> | undefined;

  try {
    await client.ready;
    browser = connectTcp({ host: "127.0.0.1", port: gatewayPort });
    browser.once("error", () => undefined);
    await onceEvent(browser, "connect");
    const upgrade = Buffer.from(
      "GET /socket HTTP/1.1\r\n" +
      "Host: pending-head-cancel.localhost\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n\r\n`,
      "ascii",
    );
    browser.write(Buffer.concat([upgrade, Buffer.alloc(40 * 1024, 7)]));
    await Promise.race([
      pendingHeadStarted,
      delay(1_000).then(() => {
        throw new Error("Gateway did not start forwarding the pending upgrade head");
      }),
    ]);

    browser.destroy();
    releasePendingHead?.(new Error("browser closed while pending head send was in flight"));
    await delay(50);
    const carrierOutcome = await Promise.race([
      client.closed.then((closed) => closed.reason),
      delay(100).then(() => "still-open" as const),
    ]);
    assert.equal(carrierOutcome, "still-open");

    const alive = await sendRequest({
      port: gatewayPort,
      host: "pending-head-cancel.localhost",
      method: "GET",
      path: "/alive",
      chunks: [],
    });
    assert.equal(alive.statusCode, 200);
    assert.equal(alive.body.toString(), "carrier-alive");
  } finally {
    releasePendingHead?.();
    WebSocket.prototype.send = originalSend;
    browser?.destroy();
    await client.disconnect().catch(() => undefined);
    await gateway.close();
    for (const socket of originSockets) socket.destroy();
    await close(origin);
  }
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

test("RECONNECTING Session도 runtime TICK에서 max TTL을 즉시 적용한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("expired"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  let currentTime = 1_000;
  const gateway = createGatewayServer({
    now: () => currentTime,
    sessionPolicy: {
      maxTtlMs: 1_000,
      idleTimeoutMs: 800,
      reconnectGraceMs: 700,
    },
    sessionTickIntervalMs: 5,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`;
  const client = connectTunnelClient({
    gatewayUrl,
    tunnelId: "reconnecting-max-ttl-test",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  const active = await client.ready;
  await client.disconnect();
  await delay(10);
  currentTime += 1_001;
  await delay(20);

  const resume = connectTunnelClient({
    gatewayUrl,
    tunnelId: active.tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    resumeSecret: active.resumeSecret,
  });
  context.after(() => resume.disconnect());
  await assert.rejects(resume.ready);
});

test("max TTL 경계에서 Carrier가 끊기면 RECONNECTING으로 남지 않고 즉시 만료한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("expired"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  let currentTime = 1_000;
  const gateway = createGatewayServer({
    now: () => currentTime,
    sessionPolicy: {
      maxTtlMs: 1_000,
      idleTimeoutMs: 800,
      reconnectGraceMs: 700,
    },
    sessionTickIntervalMs: 10_000,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "carrier-lost-at-deadline",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  const activation = await client.ready;
  currentTime += 1_000;
  await client.disconnect();
  await delay(10);

  assert.match(gateway.metrics(), /event="tunnel_expired"} 1/);
  assert.match(gateway.metrics(), /event="tunnel_reconnecting"} 0/);
  assert.match(gateway.metrics(), /review_tunnel_reconnecting_tunnels 0/);
  const resume = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: activation.tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    resumeSecret: activation.resumeSecret,
  });
  context.after(() => resume.disconnect());
  await assert.rejects(resume.ready);
});

test("HTTP max TTL과 WebSocket idle 경계의 신규 Stream을 열지 않는다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("must not open"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  let currentTime = 1_000;
  const gateway = createGatewayServer({
    now: () => currentTime,
    sessionPolicy: {
      maxTtlMs: 1_000,
      idleTimeoutMs: 100,
      reconnectGraceMs: 700,
    },
    sessionTickIntervalMs: 10_000,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`;
  const httpClient = connectTunnelClient({
    gatewayUrl,
    tunnelId: "http-open-at-max-deadline",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => httpClient.disconnect());
  await httpClient.ready;
  currentTime += 1_000;
  const http = await sendRequest({
    port: gatewayPort,
    host: "http-open-at-max-deadline.localhost",
    method: "GET",
    path: "/deadline",
    chunks: [],
  });
  assert.equal(http.statusCode, 503);

  currentTime = 3_000;
  const webSocketClient = connectTunnelClient({
    gatewayUrl,
    tunnelId: "websocket-open-at-idle-deadline",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => webSocketClient.disconnect());
  await webSocketClient.ready;
  currentTime += 100;
  const reviewer = new WebSocket(`ws://127.0.0.1:${gatewayPort}/socket`, {
    headers: { host: "websocket-open-at-idle-deadline.localhost" },
  });
  context.after(() => reviewer.terminate());
  assert.equal(await unexpectedResponseStatus(reviewer), 503);
  assert.match(gateway.metrics(), /review_tunnel_active_streams 0/);
});

test("열려 있던 마지막 Stream이 max TTL 경계에서 닫히면 Session route도 제거한다", async (context) => {
  let requestArrived!: () => void;
  const arrived = new Promise<void>((resolve) => {
    requestArrived = resolve;
  });
  let releaseResponse!: () => void;
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const origin = createServer(async (_incoming, response) => {
    requestArrived();
    await responseReleased;
    response.end("at deadline");
  });
  const originPort = await listen(origin);
  context.after(() => close(origin));
  let currentTime = 1_000;
  const gateway = createGatewayServer({
    now: () => currentTime,
    sessionPolicy: {
      maxTtlMs: 1_000,
      idleTimeoutMs: 800,
      reconnectGraceMs: 700,
    },
    sessionTickIntervalMs: 10_000,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "last-stream-close-at-deadline",
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  context.after(() => client.disconnect());
  await client.ready;
  const response = sendRequest({
    port: gatewayPort,
    host: "last-stream-close-at-deadline.localhost",
    method: "GET",
    path: "/held",
    chunks: [],
  });
  await arrived;
  currentTime += 1_000;
  releaseResponse();
  assert.equal((await response).statusCode, 200);
  await delay(10);
  const afterExpiry = await sendRequest({
    port: gatewayPort,
    host: "last-stream-close-at-deadline.localhost",
    method: "GET",
    path: "/after",
    chunks: [],
  });
  assert.equal(afterExpiry.statusCode, 503);
  assert.match(gateway.metrics(), /event="tunnel_expired"} 1/);
  assert.match(gateway.metrics(), /review_tunnel_active_tunnels 0/);
});

test("START_RESUME·RESUME_FAILED·RESUME_COMMITTED의 deadline 만료를 모두 즉시 폐기한다", async (context) => {
  const origin = createServer((_incoming, response) => response.end("must remain expired"));
  const originPort = await listen(origin);
  context.after(() => close(origin));
  const localOrigin = `http://127.0.0.1:${originPort}`;
  let currentTime = 1_000;
  const gateway = createGatewayServer({
    now: () => currentTime,
    sessionPolicy: {
      maxTtlMs: 1_000,
      idleTimeoutMs: 800,
      reconnectGraceMs: 1_000,
    },
    sessionTickIntervalMs: 10_000,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`;

  for (const [index, boundary] of ["START", "FAILED", "COMMITTED"].entries()) {
    const base = 10_000 * index + 1_000;
    currentTime = base;
    const client = connectTunnelClient({
      gatewayUrl,
      tunnelId: `resume-deadline-${boundary.toLowerCase()}`,
      localOrigin,
    });
    const activation = await client.ready;
    currentTime = base + 500;
    await client.disconnect();
    await delay(10);

    if (boundary === "START") {
      currentTime = base + 1_000;
      const rejected = new WebSocket(gatewayUrl, CARRIER_PROFILE);
      context.after(() => rejected.terminate());
      await onceEvent(rejected, "open");
      const closed = onceEvent(rejected, "close");
      rejected.send(resumeHelloEnvelope(activation, localOrigin));
      await closed;
    } else {
      currentTime = base + 900;
      const candidate = await startManualResumeCandidate(
        gatewayUrl,
        activation,
        localOrigin,
      );
      context.after(() => candidate.socket.terminate());
      currentTime = base + 1_000;
      if (boundary === "FAILED") {
        candidate.socket.terminate();
        await onceEvent(candidate.socket, "close");
      } else {
        const closed = onceEvent(candidate.socket, "close");
        candidate.socket.send(encodeEnvelope({
          type: FrameType.Data,
          flags: 0,
          generation: candidate.generation,
          streamId: candidate.probeStreamId,
          payload: candidate.probePayload,
        }));
        candidate.socket.send(encodeEnvelope({
          type: FrameType.EndStream,
          flags: 0,
          generation: candidate.generation,
          streamId: candidate.probeStreamId,
          payload: new Uint8Array(),
        }));
        await closed;
      }
      await delay(10);
    }

    const expiredRoute = await sendRequest({
      port: gatewayPort,
      host: `${activation.tunnelId}.localhost`,
      method: "GET",
      path: "/expired",
      chunks: [],
    });
    assert.equal(expiredRoute.statusCode, 503, `${boundary} left an expired route`);
  }
  assert.match(gateway.metrics(), /event="tunnel_expired"} 3/);
  assert.match(gateway.metrics(), /review_tunnel_reconnecting_tunnels 0/);
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

async function activateManualCarrier(
  socket: WebSocket,
  tunnelId: string,
): Promise<Readonly<{ generation: number; probeStreamId: number }>> {
  const provisionedReceived = nextCarrierEnvelope(socket, FrameType.SessionProvisioned);
  const configReceived = nextCarrierEnvelope(socket, FrameType.SessionConfig);
  socket.send(encodeEnvelope({
    type: FrameType.Hello,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: encodeMetadata({
      mode: "create",
      tunnelId,
      localOriginFingerprint: "A".repeat(43),
      originProjection: "local-view",
    }),
  }));
  const provisioned = decodeSessionProvisionedMetadata((await provisionedReceived).payload);
  const configEnvelope = await configReceived;
  const config = decodeSessionConfigMetadata(configEnvelope.payload);
  const probeOpened = nextCarrierEnvelope(socket, FrameType.OpenProbe);
  const probeDataReceived = nextCarrierEnvelope(socket, FrameType.Data);
  const probeEnded = nextCarrierEnvelope(socket, FrameType.EndStream);
  socket.send(encodeEnvelope({
    type: FrameType.ConfigApplied,
    flags: 0,
    generation: configEnvelope.generation,
    streamId: 0,
    payload: encodeMetadata({
      revision: config.revision,
      digest: config.digest,
      result: "APPLIED",
      localOriginReady: true,
      provisionReceipt: provisioned.provisionId,
    }),
  }));
  const probe = await probeOpened;
  const probeData = await probeDataReceived;
  await probeEnded;
  const active = nextCarrierEnvelope(socket, FrameType.SessionActive);
  socket.send(encodeEnvelope({
    type: FrameType.Data,
    flags: 0,
    generation: probe.generation,
    streamId: probe.streamId,
    payload: probeData.payload,
  }));
  socket.send(encodeEnvelope({
    type: FrameType.EndStream,
    flags: 0,
    generation: probe.generation,
    streamId: probe.streamId,
    payload: new Uint8Array(),
  }));
  await active;
  return { generation: probe.generation, probeStreamId: probe.streamId };
}

function resumeHelloEnvelope(
  activation: Readonly<{ tunnelId: string; resumeSecret: string }>,
  localOrigin: string,
): Uint8Array {
  return encodeEnvelope({
    type: FrameType.Hello,
    flags: 0,
    generation: 0,
    streamId: 0,
    payload: encodeMetadata({
      mode: "resume",
      tunnelId: activation.tunnelId,
      resumeSecret: activation.resumeSecret,
      localOriginFingerprint: createHash("sha256")
        .update("review-tunnel.v1.local-origin\0", "utf8")
        .update(localOrigin, "utf8")
        .digest("base64url"),
      originProjection: "local-view",
    }),
  });
}

async function startManualResumeCandidate(
  gatewayUrl: string,
  activation: Readonly<{ tunnelId: string; resumeSecret: string }>,
  localOrigin: string,
): Promise<Readonly<{
  socket: WebSocket;
  generation: number;
  probeStreamId: number;
  probePayload: Uint8Array;
}>> {
  const socket = new WebSocket(gatewayUrl, CARRIER_PROFILE);
  await onceEvent(socket, "open");
  const configReceived = nextCarrierEnvelope(socket, FrameType.SessionConfig);
  socket.send(resumeHelloEnvelope(activation, localOrigin));
  const configEnvelope = await configReceived;
  const config = decodeSessionConfigMetadata(configEnvelope.payload);
  const probeOpened = nextCarrierEnvelope(socket, FrameType.OpenProbe);
  const probeDataReceived = nextCarrierEnvelope(socket, FrameType.Data);
  const probeEnded = nextCarrierEnvelope(socket, FrameType.EndStream);
  socket.send(encodeEnvelope({
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
  const probe = await probeOpened;
  const probeData = await probeDataReceived;
  await probeEnded;
  return {
    socket,
    generation: probe.generation,
    probeStreamId: probe.streamId,
    probePayload: probeData.payload,
  };
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

function webSocketTransport(socket: WebSocket): Readonly<{
  cork(): void;
  uncork(): void;
  pause(): void;
  resume(): void;
}> {
  const transport = (socket as unknown as {
    _socket?: {
      cork(): void;
      uncork(): void;
      pause(): void;
      resume(): void;
    };
  })._socket;
  assert.ok(transport !== undefined);
  return transport;
}

async function rawHttp(port: number, payload: string): Promise<string> {
  const socket = connectTcp({ host: "127.0.0.1", port });
  socket.end(payload);
  return (await collect(socket)).toString("utf8");
}
