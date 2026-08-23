import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  connectTunnelClient,
  connectResilientTunnelClient,
  hasValidWebSocketUpgrade,
  type TunnelClient,
  type TunnelClientClosure,
  type TunnelClientInput,
} from "./client.ts";

function upgradeResponse(extraHeaders: readonly string[] = []): IncomingMessage {
  return {
    statusCode: 101,
    rawHeaders: [
      "Connection", "Upgrade",
      "Upgrade", "websocket",
      "Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      ...extraHeaders,
    ],
  } as IncomingMessage;
}

async function startCarrierServer(
  options: Omit<
    NonNullable<ConstructorParameters<typeof WebSocketServer>[0]>,
    "server"
  > = {},
): Promise<Readonly<{
  url: string;
  wss: WebSocketServer;
  close(): Promise<void>;
}>> {
  const server = createServer();
  const wss = new WebSocketServer({ server, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}/_review-tunnel/carrier`,
    wss,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening) {
        const closed = once(server, "close");
        server.close();
        await closed;
      }
    },
  };
}

const activation = {
  generation: 2,
  resumeSecret: "resume-secret",
  tunnelId: "activation-loss-test",
  shareUrl: "http://activation-loss-test.localhost:8787/",
  pinnedLocalAddress: "127.0.0.1",
  readiness: {
    carrier: true,
    config: true,
    origin: true,
    relay: true,
    route: true,
    admission: true,
  } as const,
};

test("SESSION_ACTIVE 전달 전 transport 유실도 provisioned context로 같은 URL을 resume한다", async () => {
  const inputs: TunnelClientInput[] = [];
  let closeSecond!: () => void;
  const secondClosed = new Promise<void>((resolve) => {
    closeSecond = resolve;
  });
  const first: TunnelClient = {
    ready: Promise.reject(new Error("Carrier closed with WebSocket code 1006")),
    activationCandidate: Promise.resolve({
      resumeSecret: activation.resumeSecret,
      pinnedLocalAddress: activation.pinnedLocalAddress,
    }),
    closed: Promise.resolve({ reason: "failed", error: new Error("transport lost") }),
    async close() {},
    async disconnect() {},
  };
  const second: TunnelClient = {
    ready: Promise.resolve(activation),
    activationCandidate: Promise.resolve({
      resumeSecret: activation.resumeSecret,
      pinnedLocalAddress: activation.pinnedLocalAddress,
    }),
    closed: secondClosed.then(() => ({ reason: "closed" as const })),
    async close() {
      closeSecond();
    },
    async disconnect() {
      closeSecond();
    },
  };
  const clients = [first, second];
  const client = connectResilientTunnelClient({
    gatewayUrl: "ws://127.0.0.1:8787/_review-tunnel/carrier",
    tunnelId: activation.tunnelId,
    localOrigin: "http://127.0.0.1:3000",
    reconnectGraceMs: 500,
    connectionFactory(input) {
      inputs.push(input);
      const next = clients.shift();
      if (next === undefined) throw new Error("unexpected reconnect attempt");
      return next;
    },
  });

  assert.deepEqual(await client.ready, activation);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1]?.resumeSecret, activation.resumeSecret);
  assert.equal(inputs[1]?.pinnedLocalAddress, activation.pinnedLocalAddress);
  await client.close();
});

test("active transport의 RESET 전달 실패는 같은 URL의 새 generation resume으로 이어진다", async () => {
  let failInitial!: () => void;
  const initialClosed = new Promise<TunnelClientClosure>((resolve) => {
    failInitial = () => resolve({
      reason: "failed",
      error: new Error("RESET delivery failed"),
    });
  });
  let closeResumed!: () => void;
  const resumedClosed = new Promise<TunnelClientClosure>((resolve) => {
    closeResumed = () => resolve({ reason: "closed" });
  });
  const initial: TunnelClient = {
    ready: Promise.resolve(activation),
    activationCandidate: Promise.resolve({
      resumeSecret: activation.resumeSecret,
      pinnedLocalAddress: activation.pinnedLocalAddress,
    }),
    closed: initialClosed,
    async close() {},
    async disconnect() {},
  };
  const resumedActivation = { ...activation, generation: activation.generation + 1 };
  const resumed: TunnelClient = {
    ready: Promise.resolve(resumedActivation),
    activationCandidate: Promise.resolve({
      resumeSecret: activation.resumeSecret,
      pinnedLocalAddress: activation.pinnedLocalAddress,
    }),
    closed: resumedClosed,
    async close() {
      closeResumed();
    },
    async disconnect() {
      closeResumed();
    },
  };
  const inputs: TunnelClientInput[] = [];
  const clients = [initial, resumed];
  let markResumed!: () => void;
  const resumedStatus = new Promise<void>((resolve) => {
    markResumed = resolve;
  });
  const client = connectResilientTunnelClient({
    gatewayUrl: "ws://127.0.0.1:8787/_review-tunnel/carrier",
    tunnelId: activation.tunnelId,
    localOrigin: "http://127.0.0.1:3000",
    reconnectGraceMs: 500,
    connectionFactory(input) {
      inputs.push(input);
      const next = clients.shift();
      if (next === undefined) throw new Error("unexpected reconnect attempt");
      return next;
    },
    onStatus(status) {
      if (status.state === "active" && status.attempt === 1) markResumed();
    },
  });

  assert.equal((await client.ready).generation, activation.generation);
  failInitial();
  await Promise.race([
    resumedStatus,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("resume did not start")), 500),
    ),
  ]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1]?.resumeSecret, activation.resumeSecret);
  await client.close();
});

test("local-origin URL userinfo를 WebSocket 연결 전에 거부한다", async () => {
  let client: TunnelClient | undefined;
  let thrown: unknown;
  try {
    client = connectTunnelClient({
      gatewayUrl: "ws://127.0.0.1:9/_review-tunnel/carrier",
      tunnelId: "userinfo-test",
      localOrigin: "http://alice:plain-secret@127.0.0.1:3000",
    });
  } catch (error) {
    thrown = error;
  }
  if (client !== undefined) {
    void client.ready.catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
  assert.match(String(thrown), /username|password|userinfo|credentials/i);
});

test("resume credential 발급이 멈춰도 reconnect deadline에 실패로 종결한다", async () => {
  let credentialSignal: AbortSignal | undefined;
  let disconnectInitial!: () => void;
  const initialClosed = new Promise<TunnelClientClosure>((resolve) => {
    disconnectInitial = () => resolve({
      reason: "failed",
      error: new Error("transport lost"),
    });
  });
  const initial: TunnelClient = {
    ready: Promise.resolve(activation),
    activationCandidate: Promise.resolve({
      resumeSecret: activation.resumeSecret,
      pinnedLocalAddress: activation.pinnedLocalAddress,
    }),
    closed: initialClosed,
    async close() {},
    async disconnect() {},
  };
  const client = connectResilientTunnelClient({
    gatewayUrl: "ws://127.0.0.1:8787/_review-tunnel/carrier",
    tunnelId: activation.tunnelId,
    localOrigin: "http://127.0.0.1:3000",
    reconnectGraceMs: 100,
    connectionFactory() {
      return initial;
    },
    issueCarrierCredential(_purpose, _tunnelId, signal) {
      credentialSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  await client.ready;
  disconnectInitial();
  const outcome = await Promise.race([
    client.closed,
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
  ]);
  assert.notEqual(outcome, "timed-out");
  assert.equal(typeof outcome === "object" ? outcome.reason : undefined, "failed");
  assert.equal(credentialSignal?.aborted, true);
});

test("resilient close는 하위 client가 ACK를 기다려도 bounded하게 종료한다", async () => {
  const current: TunnelClient = {
    ready: Promise.resolve(activation),
    activationCandidate: Promise.resolve({
      resumeSecret: activation.resumeSecret,
      pinnedLocalAddress: activation.pinnedLocalAddress,
    }),
    closed: new Promise(() => undefined),
    close: () => new Promise<void>(() => undefined),
    async disconnect() {},
  };
  const client = connectResilientTunnelClient({
    gatewayUrl: "ws://127.0.0.1:8787/_review-tunnel/carrier",
    tunnelId: activation.tunnelId,
    localOrigin: "http://127.0.0.1:3000",
    closeTimeoutMs: 20,
    connectionFactory() {
      return current;
    },
  });
  await client.ready;

  const outcome = await Promise.race([
    client.close().then(() => "closed" as const),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
  ]);
  assert.equal(outcome, "closed");
});

test("Carrier가 profile을 선택하지 않으면 handshake를 fail-closed한다", async () => {
  const carrier = await startCarrierServer({
    handleProtocols() {
      return false;
    },
  });
  try {
    const client = connectTunnelClient({
      gatewayUrl: carrier.url,
      tunnelId: "missing-profile-test",
      localOrigin: "http://127.0.0.1:1",
      activationTimeoutMs: 100,
    });
    await assert.rejects(client.ready, /no subprotocol|did not negotiate/);
    await client.closed;
  } finally {
    await carrier.close();
  }
});

test("SESSION_ACTIVE가 오지 않으면 activation deadline에 Carrier를 종료한다", async () => {
  const carrier = await startCarrierServer();
  try {
    const client = connectTunnelClient({
      gatewayUrl: carrier.url,
      tunnelId: "activation-timeout-test",
      localOrigin: "http://127.0.0.1:1",
      activationTimeoutMs: 30,
    });
    await assert.rejects(client.ready, /activation timed out/);
    assert.equal((await client.closed).reason, "failed");
  } finally {
    await carrier.close();
  }
});

test("HTTP upgrade 응답이 멈추면 WebSocket handshake deadline에 종료한다", async () => {
  const server = createServer(() => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const client = connectTunnelClient({
      gatewayUrl: `ws://127.0.0.1:${address.port}/_review-tunnel/carrier`,
      tunnelId: "handshake-timeout-test",
      localOrigin: "http://127.0.0.1:1",
      handshakeTimeoutMs: 30,
      activationTimeoutMs: 100,
    });
    await assert.rejects(client.ready, /handshake.*timed out/i);
    assert.equal((await client.closed).reason, "failed");
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  }
});

test("protocol envelope 상한보다 큰 WebSocket message를 decode 전에 거부한다", async () => {
  const carrier = await startCarrierServer();
  carrier.wss.once("connection", (socket) => {
    socket.send(Buffer.alloc(65_552));
  });
  try {
    const client = connectTunnelClient({
      gatewayUrl: carrier.url,
      tunnelId: "max-payload-test",
      localOrigin: "http://127.0.0.1:1",
      activationTimeoutMs: 100,
    });
    await assert.rejects(client.ready);
    assert.equal((await client.closed).reason, "failed");
  } finally {
    await carrier.close();
  }
});

test("local WebSocket 101은 제안한 subprotocol만 선택하고 extension은 비활성화한다", () => {
  const requestHeaders = [
    ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
    ["Sec-WebSocket-Protocol", "chat, superchat"],
    ["Sec-WebSocket-Extensions", "permessage-deflate; client_max_window_bits"],
  ] as const;

  assert.equal(hasValidWebSocketUpgrade(
    requestHeaders,
    upgradeResponse(["Sec-WebSocket-Protocol", "chat"]),
  ), true);
  assert.equal(hasValidWebSocketUpgrade(
    requestHeaders,
    upgradeResponse(["Sec-WebSocket-Protocol", "admin"]),
  ), false);
  assert.equal(hasValidWebSocketUpgrade(
    requestHeaders,
    upgradeResponse(["Sec-WebSocket-Extensions", "permessage-deflate"]),
  ), false);
});
