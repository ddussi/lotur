import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { WebSocket } from "ws";

import {
  AuthError,
  AuthService,
  InMemoryAuthRepository,
  type PasswordHasher,
} from "../../../packages/auth/src/index.ts";
import { CARRIER_PROFILE } from "../../../packages/protocol/src/index.ts";
import { createGatewayServer } from "./server.ts";

class DeadlineTestHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

const DISCARD_AUTHENTICATION_EVENTS = { write() {}, reportFailure() {} };

test("read-only reviewer WebSocket upgrade 인증은 hard deadline 뒤 연결을 정리한다", async (context) => {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new DeadlineTestHasher(),
    sessionHmacKey: Buffer.alloc(32, 7),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  authService.resolveSession = async () => new Promise<never>(() => undefined);

  const gateway = createGatewayServer({
    authService,
    secureCookies: false,
    controlHost: "control.localhost",
    authorizationQueryTimeoutMs: 25,
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const startedAt = Date.now();
  const reviewer = new WebSocket(`ws://127.0.0.1:${gatewayPort}/socket`, {
    headers: {
      host: "deadline.localhost",
      cookie: `rt_session_dev=${"B".repeat(32)}`,
    },
  });
  context.after(() => reviewer.terminate());
  assert.equal(await unexpectedResponseStatus(reviewer), 503);
  assert.ok(Date.now() - startedAt < 500, "upgrade authorization deadline did not bound cleanup");
});

test("readiness health query는 deadline 뒤에도 settle까지 single-flight를 유지한다", async () => {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new DeadlineTestHasher(),
    sessionHmacKey: Buffer.alloc(32, 12),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  let healthCalls = 0;
  let releaseFirstHealth!: () => void;
  const heldFirstHealth = new Promise<void>((resolve) => {
    releaseFirstHealth = resolve;
  });
  authService.checkHealth = async () => {
    healthCalls += 1;
    if (healthCalls === 1) await heldFirstHealth;
  };
  const gateway = createGatewayServer({
    authService,
    secureCookies: false,
    controlHost: "control.localhost",
    authorizationQueryTimeoutMs: 20,
  });
  const gatewayPort = await gateway.listen();

  try {
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => getReady(gatewayPort)),
    );
    assert.ok(concurrent.every((status) => status === 503));
    assert.equal(healthCalls, 1, "concurrent readiness requests did not coalesce");

    assert.equal(await getReady(gatewayPort), 503);
    assert.equal(healthCalls, 1, "deadline released an unsettled health check");

    releaseFirstHealth();
    await delay(0);
    assert.equal(await getReady(gatewayPort), 200);
    assert.equal(healthCalls, 2, "settled health check did not release single-flight");
  } finally {
    releaseFirstHealth();
    await gateway.close();
  }
});

test("Carrier credential consume는 timeout과 경쟁하지 않고 settle까지 admission을 유지한다", async () => {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new DeadlineTestHasher(),
    sessionHmacKey: Buffer.alloc(32, 9),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  let markConsumeStarted!: () => void;
  const consumeStarted = new Promise<void>((resolve) => {
    markConsumeStarted = resolve;
  });
  let releaseConsume!: () => void;
  const heldConsume = new Promise<void>((resolve) => {
    releaseConsume = resolve;
  });
  authService.consumeCarrierCredential = async () => {
    markConsumeStarted();
    await heldConsume;
    return {
      accountId: "developer-id",
      accountAuthVersion: 1,
      username: "developer",
      purpose: "create",
      tunnelId: "deferred-consume",
    };
  };
  const gateway = createGatewayServer({
    authService,
    secureCookies: false,
    controlHost: "control.localhost",
    authorizationQueryTimeoutMs: 25,
    maxPendingTunnels: 1,
  });
  const gatewayPort = await gateway.listen();
  const first = carrierSocket(gatewayPort, "A".repeat(32));
  const firstOutcome = upgradeOutcome(first);
  let second: WebSocket | undefined;

  try {
    await consumeStarted;
    let firstSettled = false;
    void firstOutcome.then(() => {
      firstSettled = true;
    });
    await delay(50);
    assert.equal(firstSettled, false, "Carrier consume was raced by the query deadline");

    second = carrierSocket(gatewayPort, "B".repeat(32));
    assert.equal(await unexpectedResponseStatus(second), 429);

    releaseConsume();
    assert.equal(await firstOutcome, "open");
  } finally {
    releaseConsume();
    first.terminate();
    second?.terminate();
    await gateway.close();
  }
});

test("Carrier client가 consume 중 연결을 닫아도 underlying settle 전 admission을 해제하지 않는다", async () => {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new DeadlineTestHasher(),
    sessionHmacKey: Buffer.alloc(32, 10),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  let consumeCalls = 0;
  let markConsumeStarted!: () => void;
  const consumeStarted = new Promise<void>((resolve) => {
    markConsumeStarted = resolve;
  });
  let releaseConsume!: () => void;
  const heldConsume = new Promise<void>((resolve) => {
    releaseConsume = resolve;
  });
  authService.consumeCarrierCredential = async () => {
    consumeCalls += 1;
    markConsumeStarted();
    await heldConsume;
    throw new AuthError("FORBIDDEN", "credential rejected after deferred lookup");
  };
  const gateway = createGatewayServer({
    authService,
    secureCookies: false,
    controlHost: "control.localhost",
    maxPendingTunnels: 1,
  });
  const gatewayPort = await gateway.listen();
  const first = carrierSocket(gatewayPort, "C".repeat(32));
  first.once("error", () => undefined);
  let second: WebSocket | undefined;

  try {
    await consumeStarted;
    const firstClosed = new Promise<void>((resolve) => {
      first.once("close", () => resolve());
    });
    first.terminate();
    await firstClosed;
    await delay(20);

    second = carrierSocket(gatewayPort, "D".repeat(32));
    const status = await Promise.race([
      unexpectedResponseStatus(second),
      delay(100).then(() => -1),
    ]);
    assert.equal(status, 429);
    assert.equal(consumeCalls, 1);
  } finally {
    releaseConsume();
    first.terminate();
    second?.terminate();
    await gateway.close();
  }
});

test("consume 완료 전 닫힌 Carrier는 pending slot을 누수하지 않는다", async () => {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new DeadlineTestHasher(),
    sessionHmacKey: Buffer.alloc(32, 11),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  let consumeCalls = 0;
  let markFirstConsumeStarted!: () => void;
  const firstConsumeStarted = new Promise<void>((resolve) => {
    markFirstConsumeStarted = resolve;
  });
  let releaseFirstConsume!: () => void;
  const heldFirstConsume = new Promise<void>((resolve) => {
    releaseFirstConsume = resolve;
  });
  let markFirstConsumeSettled!: () => void;
  const firstConsumeSettled = new Promise<void>((resolve) => {
    markFirstConsumeSettled = resolve;
  });
  authService.consumeCarrierCredential = async () => {
    consumeCalls += 1;
    if (consumeCalls !== 1) {
      throw new AuthError("FORBIDDEN", "test credential rejected");
    }
    markFirstConsumeStarted();
    await heldFirstConsume;
    markFirstConsumeSettled();
    return {
      accountId: "developer-id",
      accountAuthVersion: 1,
      username: "developer",
      purpose: "create",
      tunnelId: "closed-before-consume-settled",
    };
  };
  const gateway = createGatewayServer({
    authService,
    secureCookies: false,
    controlHost: "control.localhost",
    maxPendingTunnels: 1,
  });
  const gatewayPort = await gateway.listen();
  const first = carrierSocket(gatewayPort, "E".repeat(32));
  first.once("error", () => undefined);
  let second: WebSocket | undefined;
  let third: WebSocket | undefined;

  try {
    await firstConsumeStarted;
    const firstClosed = new Promise<void>((resolve) => {
      first.once("close", () => resolve());
    });
    first.terminate();
    await firstClosed;

    second = carrierSocket(gatewayPort, "F".repeat(32));
    assert.equal(await unexpectedResponseStatus(second), 429);

    releaseFirstConsume();
    await firstConsumeSettled;
    await delay(20);

    third = carrierSocket(gatewayPort, "G".repeat(32));
    assert.equal(await unexpectedResponseStatus(third), 401);
    assert.equal(consumeCalls, 2, "third Carrier never reached credential consume");
  } finally {
    releaseFirstConsume();
    first.terminate();
    second?.terminate();
    third?.terminate();
    await gateway.close();
  }
});

test("DB-atomic 인증 artifact capacity는 API에서 Retry-After가 있는 429로 노출한다", async (context) => {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new DeadlineTestHasher(),
    sessionHmacKey: Buffer.alloc(32, 8),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  authService.authenticate = async () => {
    throw new AuthError("AUTH_CAPACITY", "authentication capacity reached");
  };
  const gateway = createGatewayServer({
    authService,
    secureCookies: false,
    controlHost: "control.localhost",
  });
  const gatewayPort = await gateway.listen();
  context.after(() => gateway.close());

  const response = await postForm(gatewayPort, "/api/client/login", {
    username: "known-or-unknown",
    password: "irrelevant-password",
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "60");
  assert.match(response.body, /AUTH_CAPACITY/);
});

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

function carrierSocket(port: number, token: string): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${port}/_review-tunnel/carrier`,
    CARRIER_PROFILE,
    {
      headers: {
        host: "control.localhost",
        authorization: `Bearer ${token}`,
      },
    },
  );
}

function upgradeOutcome(socket: WebSocket): Promise<"open" | number> {
  return new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => resolve("open"));
    socket.once("error", reject);
  });
}

function postForm(
  port: number,
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<Readonly<{
  statusCode: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: string;
}>> {
  const body = new URLSearchParams(values).toString();
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        host: "control.localhost",
        "x-review-tunnel-client": "1",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
    });
    outgoing.once("error", reject);
    outgoing.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => resolve({
        statusCode: incoming.statusCode ?? 0,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      incoming.once("error", reject);
    });
    outgoing.end(body);
  });
}

function getReady(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/health/ready",
      headers: { host: "control.localhost" },
    });
    outgoing.once("error", reject);
    outgoing.once("response", (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(incoming.statusCode ?? 0));
      incoming.once("error", reject);
    });
    outgoing.end();
  });
}
