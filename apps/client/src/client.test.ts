import assert from "node:assert/strict";
import test from "node:test";

import {
  connectResilientTunnelClient,
  type TunnelClient,
  type TunnelClientInput,
} from "./client.ts";

test("SESSION_ACTIVE 전달 전 transport 유실도 provisioned context로 같은 URL을 resume한다", async () => {
  const inputs: TunnelClientInput[] = [];
  let closeSecond!: () => void;
  const secondClosed = new Promise<void>((resolve) => {
    closeSecond = resolve;
  });
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
