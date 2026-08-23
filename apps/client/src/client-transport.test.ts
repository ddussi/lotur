import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

import {
  CARRIER_PROFILE,
  createSessionConfigSnapshot,
  decodeEnvelope,
  digestSessionConfig,
  encodeEnvelope,
  encodeMetadata,
  FrameType,
  encodeWindowUpdate,
  type FrameTypeValue,
  type SessionConfigSnapshot,
} from "../../../packages/protocol/src/index.ts";
import { connectTunnelClient, type TunnelClient } from "./client.ts";

type Envelope = ReturnType<typeof decodeEnvelope>;

class EnvelopeQueue {
  readonly #pending: Envelope[] = [];
  readonly #waiters = new Set<{
    predicate: (envelope: Envelope) => boolean;
    resolve: (envelope: Envelope) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  push(envelope: Envelope): void {
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(envelope)) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(envelope);
      return;
    }
    this.#pending.push(envelope);
  }

  async next(
    predicate: (envelope: Envelope) => boolean,
    timeoutMs = 1_000,
  ): Promise<Envelope> {
    const index = this.#pending.findIndex(predicate);
    if (index >= 0) return this.#pending.splice(index, 1)[0] as Envelope;
    return await new Promise<Envelope>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("expected Carrier frame did not arrive"));
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.#waiters.add(waiter);
    });
  }
}

type ActivatedHarness = Readonly<{
  client: TunnelClient;
  carrier: WebSocket;
  frames: EnvelopeQueue;
  configuration: SessionConfigSnapshot;
  send(type: FrameTypeValue, streamId: number, payload?: Uint8Array): void;
  close(): Promise<void>;
}>;

async function startActivatedHarness(
  requestListener: RequestListener,
  input: Readonly<{
    initialConnectionWindowBytes?: number;
    initialStreamWindowBytes?: number;
    responseHeaderTimeoutMs?: number;
    upgradeListener?: (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => void;
  }> = {},
): Promise<ActivatedHarness> {
  const localServer = createServer(requestListener);
  const localConnections = new Set<Duplex>();
  localServer.on("connection", (socket) => {
    localConnections.add(socket);
    socket.once("close", () => localConnections.delete(socket));
  });
  if (input.upgradeListener !== undefined) {
    localServer.on("upgrade", input.upgradeListener);
  }
  localServer.listen(0, "127.0.0.1");
  await once(localServer, "listening");
  const localAddress = localServer.address() as AddressInfo;
  const localOrigin = `http://127.0.0.1:${localAddress.port}`;

  const carrierServer = createServer();
  const wss = new WebSocketServer({ server: carrierServer });
  carrierServer.listen(0, "127.0.0.1");
  await once(carrierServer, "listening");
  const carrierAddress = carrierServer.address() as AddressInfo;
  const carrierConnection = once(wss, "connection").then(([socket]) => socket as WebSocket);

  const tunnelId = "transport-test";
  const client = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${carrierAddress.port}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin,
    activationTimeoutMs: 2_000,
    closeTimeoutMs: 100,
  });
  const carrier = await carrierConnection;
  assert.equal(carrier.protocol, CARRIER_PROFILE);
  const frames = new EnvelopeQueue();
  carrier.on("message", (data, isBinary) => {
    if (isBinary) frames.push(decodeEnvelope(new Uint8Array(data as Buffer)));
  });
  await frames.next((frame) => frame.type === FrameType.Hello);

  const localOriginFingerprint = createHash("sha256")
    .update("review-tunnel.v1.local-origin\0", "utf8")
    .update(localOrigin, "utf8")
    .digest("base64url");
  const configuration = createSessionConfigSnapshot({
    generation: 1,
    localOriginFingerprint,
    originProjection: "local-view",
    publicOrigin: "http://transport-test.preview.example",
    initialConnectionWindowBytes: input.initialConnectionWindowBytes ?? 256 * 1024,
    initialStreamWindowBytes: input.initialStreamWindowBytes ?? 64 * 1024,
    limits: {
      maxRequestBodyBytes: 16 * 1024 * 1024,
      maxFiniteResponseBytes: 64 * 1024 * 1024,
      maxConcurrentStreams: 128,
      maxNewStreamsPerMinute: 600,
      responseHeaderTimeoutMs: input.responseHeaderTimeoutMs ?? 30,
      streamInactivityTimeoutMs: 5_000,
      maxStreamDurationMs: 5_000,
    },
  });
  const send = (
    type: FrameTypeValue,
    streamId: number,
    payload: Uint8Array = new Uint8Array(),
  ) => carrier.send(encodeEnvelope({
    type,
    flags: 0,
    generation: 1,
    streamId,
    payload,
  }));

  send(FrameType.SessionProvisioned, 0, encodeMetadata({
    sessionId: "session-identifier",
    provisionId: "provision-identifier",
    tunnelId,
    shareUrl: "http://transport-test.preview.example/",
    resumeSecret: "A".repeat(43),
  }));
  send(FrameType.SessionConfig, 0, encodeMetadata({
    revision: 1,
    digest: digestSessionConfig(configuration),
    snapshot: configuration,
  }));
  await frames.next((frame) => frame.type === FrameType.ConfigApplied);
  send(FrameType.OpenProbe, 1, encodeMetadata({ initialWindowBytes: 64 * 1024 }));
  send(FrameType.Data, 1, Uint8Array.of(7));
  send(FrameType.EndStream, 1);
  await frames.next((frame) => frame.type === FrameType.WindowUpdate && frame.streamId === 1);
  const echo = await frames.next((frame) => frame.type === FrameType.Data && frame.streamId === 1);
  assert.deepEqual(echo.payload, Uint8Array.of(7));
  await frames.next((frame) => frame.type === FrameType.EndStream && frame.streamId === 1);
  send(FrameType.SessionActive, 0, encodeMetadata({
    generation: 1,
    tunnelId,
    shareUrl: "http://transport-test.preview.example/",
    readiness: {
      carrier: true,
      config: true,
      origin: true,
      relay: true,
      route: true,
      admission: true,
    },
  }));
  await client.ready;

  return {
    client,
    carrier,
    frames,
    configuration,
    send,
    async close() {
      await client.disconnect().catch(() => undefined);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (carrierServer.listening) {
        const closed = once(carrierServer, "close");
        carrierServer.close();
        await closed;
      }
      if (localServer.listening) {
        for (const socket of localConnections) socket.destroy();
        localServer.closeAllConnections();
        const closed = once(localServer, "close");
        localServer.close();
        await closed;
      }
    },
  };
}

function openHttpPayload(input: Readonly<{
  path: string;
  requestBodyEnded: boolean;
  kind?: "HTTP" | "WEBSOCKET";
  initialWindowBytes?: number;
  headers?: readonly (readonly [string, string])[];
}>): Uint8Array {
  return encodeMetadata({
    kind: input.kind ?? "HTTP",
    method: input.kind === "WEBSOCKET" ? "GET" : "POST",
    path: input.path,
    headers: input.headers ?? [["Host", "transport-test.preview.example"]],
    requestBodyEnded: input.requestBodyEnded,
    initialWindowBytes: input.initialWindowBytes ?? 64 * 1024,
  });
}

test("response header deadline은 느린 request upload가 끝난 뒤 시작하고 stream ID는 재사용할 수 없다", async () => {
  const harness = await startActivatedHarness((request, response) => {
    request.resume();
    request.once("end", () => response.end("ok"));
  }, { responseHeaderTimeoutMs: 30 });
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/upload",
      requestBodyEnded: false,
    }));
    harness.send(FrameType.Data, 3, new TextEncoder().encode("part"));
    await harness.frames.next(
      (frame) => frame.type === FrameType.WindowUpdate && frame.streamId === 3,
    );
    await delay(60);
    harness.send(FrameType.EndStream, 3);
    await harness.frames.next(
      (frame) => frame.type === FrameType.ResponseHeaders && frame.streamId === 3,
    );
    await harness.frames.next(
      (frame) => frame.type === FrameType.EndStream && frame.streamId === 3,
    );

    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/reused",
      requestBodyEnded: true,
    }));
    assert.equal((await harness.client.closed).reason, "failed");
  } finally {
    await harness.close();
  }
});

test("한 local upload write stall이 Carrier control과 다른 Stream을 막지 않는다", async () => {
  const harness = await startActivatedHarness((request, response) => {
    if (request.url === "/stall") return;
    request.resume();
    request.once("end", () => response.end());
  }, {
    initialConnectionWindowBytes: 32 * 1024 * 1024,
    initialStreamWindowBytes: 16 * 1024 * 1024,
    responseHeaderTimeoutMs: 2_000,
  });
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/stall",
      requestBodyEnded: false,
    }));
    let remaining = 16 * 1024 * 1024;
    while (remaining > 0) {
      const bytes = Math.min(remaining, 0xffff);
      harness.send(FrameType.Data, 3, new Uint8Array(bytes));
      remaining -= bytes;
    }
    harness.send(FrameType.Ping, 0);
    harness.send(FrameType.OpenHttp, 5, openHttpPayload({
      path: "/fast",
      requestBodyEnded: true,
    }));

    await harness.frames.next((frame) => frame.type === FrameType.Pong, 2_000);
    await harness.frames.next(
      (frame) => frame.type === FrameType.ResponseHeaders && frame.streamId === 5,
      2_000,
    );
  } finally {
    await harness.close();
  }
});

test("local origin 실패로 RESET한 stream의 이미-flight continuation은 stream 단위로 무시한다", async () => {
  const harness = await startActivatedHarness((request) => {
    request.socket.destroy();
  });
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/origin-failure",
      requestBodyEnded: true,
    }));
    await harness.frames.next(
      (frame) => frame.type === FrameType.ResetStream && frame.streamId === 3,
    );

    harness.send(FrameType.Data, 3, Uint8Array.of(1));
    harness.send(FrameType.EndStream, 3);
    harness.send(FrameType.ResetStream, 3, encodeMetadata({ code: "ALREADY_IN_FLIGHT" }));
    harness.send(FrameType.WindowUpdate, 3, encodeWindowUpdate(1));
    harness.send(FrameType.Ping, 0);
    await harness.frames.next((frame) => frame.type === FrameType.Pong);

    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/reused",
      requestBodyEnded: true,
    }));
    assert.equal((await harness.client.closed).reason, "failed");
  } finally {
    await harness.close();
  }
});

test("local-origin RESET 전달이 지연되거나 실패하면 Carrier를 fail-close한다", async (context) => {
  for (const mode of ["deferred", "rejected"] as const) {
    await context.test(mode, async () => {
      const originalSend = WebSocket.prototype.send;
      let markResetAttempted!: () => void;
      const resetAttempted = new Promise<void>((resolve) => {
        markResetAttempted = resolve;
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
            envelope.type === FrameType.ResetStream &&
            envelope.streamId === 3 &&
            typeof callback === "function"
          ) {
            markResetAttempted();
            if (mode === "rejected") {
              queueMicrotask(() => (callback as (error?: Error) => void)(
                new Error("RESET send rejected"),
              ));
            }
            return;
          }
        } catch {
          // Non-protocol application frames use the original implementation.
        }
        Reflect.apply(originalSend, this, [data, ...arguments_]);
      } as typeof WebSocket.prototype.send;

      let harness: ActivatedHarness | undefined;
      try {
        harness = await startActivatedHarness((request) => request.socket.destroy());
        const carrierClosed = once(harness.carrier, "close");
        harness.send(FrameType.OpenHttp, 3, openHttpPayload({
          path: `/reset-${mode}`,
          requestBodyEnded: true,
        }));
        await resetAttempted;
        const closure = await Promise.race([
          harness.client.closed,
          delay(500, undefined, { ref: false }).then(() => "timeout" as const),
        ]);
        assert.notEqual(closure, "timeout");
        assert.equal(typeof closure === "object" ? closure.reason : undefined, "failed");
        await carrierClosed;
      } finally {
        WebSocket.prototype.send = originalSend;
        await harness?.close();
      }
    });
  }
});

test("Carrier WebSocket control ping/pong은 자동 응답 없이 1002 fail-close한다", async (context) => {
  for (const controlFrame of ["ping", "pong"] as const) {
    await context.test(controlFrame, async () => {
      const harness = await startActivatedHarness((_request, response) => response.end());
      try {
        let automaticPong = false;
        harness.carrier.once("pong", () => {
          automaticPong = true;
        });
        const carrierClosed = once(harness.carrier, "close") as Promise<[number]>;
        harness.carrier[controlFrame](Buffer.from("unexpected-control"));
        const closure = await Promise.race([
          harness.client.closed,
          delay(500, undefined, { ref: false }).then(() => "timeout" as const),
        ]);
        assert.notEqual(closure, "timeout");
        assert.equal(typeof closure === "object" ? closure.reason : undefined, "failed");
        assert.equal((await carrierClosed)[0], 1002);
        if (controlFrame === "ping") assert.equal(automaticPong, false);
      } finally {
        await harness.close();
      }
    });
  }
});

test("retired DATA는 local-reset 당시 connection credit까지만 허용한다", async () => {
  const harness = await startActivatedHarness(
    (request) => request.socket.destroy(),
    { initialConnectionWindowBytes: 4, initialStreamWindowBytes: 4 },
  );
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/bounded-late-data",
      requestBodyEnded: true,
    }));
    await harness.frames.next(
      (frame) => frame.type === FrameType.ResetStream && frame.streamId === 3,
    );

    for (let index = 0; index < 4; index += 1) {
      harness.send(FrameType.Data, 3, Uint8Array.of(index));
    }
    harness.send(FrameType.Ping, 0);
    await harness.frames.next((frame) => frame.type === FrameType.Pong);

    harness.send(FrameType.Data, 3, Uint8Array.of(5));
    assert.equal(await Promise.race([
      harness.client.closed.then((closed) => closed.reason),
      delay(1_000, undefined, { ref: false }).then(() => "timeout" as const),
    ]), "failed");
  } finally {
    await harness.close();
  }
});

test("retired stream의 malformed/empty continuation은 계속 fail-closed한다", async (context) => {
  const malformedFrames: readonly ((harness: ActivatedHarness) => void)[] = [
    (harness) => harness.send(FrameType.Data, 3),
    (harness) => harness.send(FrameType.ResetStream, 3, encodeMetadata({ code: "" })),
    (harness) => harness.send(FrameType.WindowUpdate, 3, Uint8Array.of(1)),
    (harness) => {
      const frame = encodeEnvelope({
        type: FrameType.Data,
        flags: 0,
        generation: 1,
        streamId: 3,
        payload: Uint8Array.of(1),
      });
      frame[3] = FrameType.EndStream;
      harness.carrier.send(frame);
    },
  ];

  for (const [index, sendMalformed] of malformedFrames.entries()) {
    await context.test(`malformed continuation ${index + 1}`, async () => {
      const harness = await startActivatedHarness((request) => request.socket.destroy());
      try {
        harness.send(FrameType.OpenHttp, 3, openHttpPayload({
          path: `/origin-failure-${index}`,
          requestBodyEnded: true,
        }));
        await harness.frames.next(
          (frame) => frame.type === FrameType.ResetStream && frame.streamId === 3,
        );
        sendMalformed(harness);
        assert.equal((await harness.client.closed).reason, "failed");
      } finally {
        await harness.close();
      }
    });
  }
});

test("active stream의 outstanding을 초과한 WINDOW_UPDATE는 계속 fail-closed한다", async () => {
  const harness = await startActivatedHarness(() => undefined);
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/invalid-flow-update",
      requestBodyEnded: false,
    }));
    harness.send(FrameType.WindowUpdate, 3, encodeWindowUpdate(1));
    assert.equal((await harness.client.closed).reason, "failed");
  } finally {
    await harness.close();
  }
});

test("CLOSE_SESSION ACK가 오지 않아도 close deadline에 transport를 강제 종료한다", async () => {
  const harness = await startActivatedHarness((_request, response) => response.end());
  try {
    const startedAt = Date.now();
    await harness.client.close();
    assert.ok(Date.now() - startedAt < 500);
    assert.equal((await harness.client.closed).reason, "closed");
  } finally {
    await harness.close();
  }
});

test("local WebSocket producer는 flow credit이 막히면 한 chunk에서 pause하고 control을 유지한다", async () => {
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  let localExtensionHeader: string | string[] | undefined;
  const harness = await startActivatedHarness((_request, response) => response.end(), {
    responseHeaderTimeoutMs: 1_000,
    upgradeListener(request, socket) {
      localExtensionHeader = request.headers["sec-websocket-extensions"];
      socket.on("error", () => undefined);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      setTimeout(() => socket.write(Buffer.alloc(1024 * 1024, 7)), 20).unref();
    },
  });
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/socket",
      requestBodyEnded: true,
      kind: "WEBSOCKET",
      initialWindowBytes: 1,
      headers: [
        ["Host", "transport-test.preview.example"],
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Sec-WebSocket-Version", "13"],
        ["Sec-WebSocket-Key", key],
        ["Sec-WebSocket-Extensions", "permessage-deflate"],
      ],
    }));
    await harness.frames.next(
      (frame) => frame.type === FrameType.ResponseHeaders && frame.streamId === 3,
    );
    assert.equal(localExtensionHeader, undefined);
    const firstData = await harness.frames.next(
      (frame) => frame.type === FrameType.Data && frame.streamId === 3,
    );
    assert.equal(firstData.payload.byteLength, 1);

    harness.send(FrameType.Ping, 0);
    await harness.frames.next((frame) => frame.type === FrameType.Pong);
    await assert.rejects(() => harness.frames.next(
      (frame) => frame.type === FrameType.Data && frame.streamId === 3,
      50,
    ));

    harness.send(FrameType.ResetStream, 3, encodeMetadata({ code: "TEST_DONE" }));
  } finally {
    await harness.close();
  }
});

test("local WebSocket raw half-close 상태는 101 전달 전에 초기화된다", async () => {
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  const harness = await startActivatedHarness((_request, response) => response.end(), {
    responseHeaderTimeoutMs: 1_000,
    upgradeListener(_request, socket) {
      socket.on("error", () => undefined);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\nAB`,
      );
    },
  });
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/half-close",
      requestBodyEnded: true,
      kind: "WEBSOCKET",
      initialWindowBytes: 1,
      headers: [
        ["Host", "transport-test.preview.example"],
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Sec-WebSocket-Version", "13"],
        ["Sec-WebSocket-Key", key],
      ],
    }));
    await harness.frames.next(
      (frame) => frame.type === FrameType.ResponseHeaders && frame.streamId === 3,
    );
    await harness.frames.next(
      (frame) => frame.type === FrameType.Data && frame.streamId === 3,
    );

    harness.send(FrameType.EndStream, 3);
    harness.send(FrameType.Ping, 0);
    await harness.frames.next((frame) => frame.type === FrameType.Pong);
    harness.send(FrameType.ResetStream, 3, encodeMetadata({ code: "TEST_DONE" }));
  } finally {
    await harness.close();
  }
});

test("local WebSocket END 전달 실패는 stream reset 경계에서 정리한다", async (context) => {
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");

  for (const mode of ["callback-error", "carrier-closed"] as const) {
    await context.test(mode, async () => {
      const originalSend = WebSocket.prototype.send;
      let markEndAttempted!: () => void;
      const endAttempted = new Promise<void>((resolve) => {
        markEndAttempted = resolve;
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
            envelope.type === FrameType.EndStream &&
            envelope.streamId === 3 &&
            typeof callback === "function"
          ) {
            markEndAttempted();
            if (mode === "carrier-closed") this.terminate();
            queueMicrotask(() => (callback as (error?: Error) => void)(
              new Error("END send rejected"),
            ));
            return;
          }
        } catch {
          // Non-protocol application frames use the original implementation.
        }
        Reflect.apply(originalSend, this, [data, ...arguments_]);
      } as typeof WebSocket.prototype.send;

      let harness: ActivatedHarness | undefined;
      try {
        harness = await startActivatedHarness((_request, response) => response.end(), {
          responseHeaderTimeoutMs: 1_000,
          upgradeListener(_request, socket) {
            socket.on("error", () => undefined);
            socket.write(
              "HTTP/1.1 101 Switching Protocols\r\n" +
              "Connection: Upgrade\r\n" +
              "Upgrade: websocket\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            setTimeout(() => socket.end(), 20).unref();
          },
        });
        const carrierClosed = once(harness.carrier, "close");
        harness.send(FrameType.OpenHttp, 3, openHttpPayload({
          path: `/end-send-${mode}`,
          requestBodyEnded: true,
          kind: "WEBSOCKET",
          headers: [
            ["Host", "transport-test.preview.example"],
            ["Connection", "Upgrade"],
            ["Upgrade", "websocket"],
            ["Sec-WebSocket-Version", "13"],
            ["Sec-WebSocket-Key", key],
          ],
        }));
        await endAttempted;

        if (mode === "callback-error") {
          await harness.frames.next(
            (frame) => frame.type === FrameType.ResetStream && frame.streamId === 3,
          );
          harness.send(FrameType.Ping, 0);
          await harness.frames.next((frame) => frame.type === FrameType.Pong);
        } else {
          const closure = await Promise.race([
            harness.client.closed,
            delay(500, undefined, { ref: false }).then(() => "timeout" as const),
          ]);
          assert.notEqual(closure, "timeout");
          assert.equal(typeof closure === "object" ? closure.reason : undefined, "failed");
          assert.match(
            typeof closure === "object" ? closure.error?.message ?? "" : "",
            /Failed to deliver RESET_STREAM 3/,
          );
          await carrierClosed;
        }
      } finally {
        WebSocket.prototype.send = originalSend;
        await harness?.close();
      }
    });
  }
});

test("local WebSocket은 101 직후 socket error도 stream reset으로 격리한다", async () => {
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  const harness = await startActivatedHarness((_request, response) => response.end(), {
    responseHeaderTimeoutMs: 1_000,
    upgradeListener(_request, socket) {
      socket.on("error", () => undefined);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\nAB`,
        () => (socket as Duplex & { resetAndDestroy(): void }).resetAndDestroy(),
      );
    },
  });
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/reset-after-upgrade",
      requestBodyEnded: true,
      kind: "WEBSOCKET",
      initialWindowBytes: 1,
      headers: [
        ["Host", "transport-test.preview.example"],
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Sec-WebSocket-Version", "13"],
        ["Sec-WebSocket-Key", key],
      ],
    }));
    await harness.frames.next(
      (frame) => frame.type === FrameType.ResetStream && frame.streamId === 3,
    );
    harness.send(FrameType.Ping, 0);
    await harness.frames.next((frame) => frame.type === FrameType.Pong);
  } finally {
    await harness.close();
  }
});

test("Gateway DATA가 advertised inbound flow credit을 넘으면 Carrier를 종료한다", async () => {
  const harness = await startActivatedHarness((request, response) => {
    request.resume();
    request.once("end", () => response.end());
  }, {
    initialConnectionWindowBytes: 8,
    initialStreamWindowBytes: 4,
  });
  try {
    harness.send(FrameType.OpenHttp, 3, openHttpPayload({
      path: "/flow-overrun",
      requestBodyEnded: false,
    }));
    harness.send(FrameType.Data, 3, new Uint8Array(5));
    assert.equal((await harness.client.closed).reason, "failed");
  } finally {
    await harness.close();
  }
});
