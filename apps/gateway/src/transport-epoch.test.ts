import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { WebSocket } from "ws";

import {
  AuthService,
  InMemoryAuthRepository,
  type PasswordHasher,
  type Principal,
} from "../../../packages/auth/src/index.ts";
import {
  CARRIER_PROFILE,
  decodeEnvelope,
  encodeEnvelope,
  encodeMetadata,
  FrameType,
} from "../../../packages/protocol/src/index.ts";
import { connectTunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "./server.ts";

class EpochTestHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

test("stale reviewer revocation cannot remove a reused stream ID after resume", async () => {
  const tunnelId = "revocation-epoch";
  const reviewerA = principal("reviewer-a", "reviewer-a-session");
  const reviewerB = principal("reviewer-b", "reviewer-b-session");
  const authService = createAuthService();
  const createCredential = "C".repeat(32);
  const resumeCredential = "R".repeat(32);
  authService.consumeCarrierCredential = async (token) => ({
    accountId: "developer-id",
    accountAuthVersion: 1,
    username: "developer",
    purpose: token === createCredential ? "create" : "resume",
    tunnelId,
  });
  authService.resolveSession = async (token) => {
    if (token === "reviewer-a-cookie") return reviewerA;
    if (token === "reviewer-b-cookie") return reviewerB;
    return undefined;
  };
  let markReviewerACheckStarted!: () => void;
  const reviewerACheckStarted = new Promise<void>((resolve) => {
    markReviewerACheckStarted = resolve;
  });
  let resolveReviewerACheck!: (authorized: boolean) => void;
  const heldReviewerACheck = new Promise<boolean>((resolve) => {
    resolveReviewerACheck = resolve;
  });
  let reviewerACheckCaptured = false;
  setAuthorizationCheck(authService, async (accountId) => {
    if (accountId === reviewerA.accountId && !reviewerACheckCaptured) {
      reviewerACheckCaptured = true;
      markReviewerACheckStarted();
      return heldReviewerACheck;
    }
    return true;
  });

  let markOriginAStarted!: () => void;
  const originAStarted = new Promise<void>((resolve) => {
    markOriginAStarted = resolve;
  });
  let markOriginBStarted!: () => void;
  const originBStarted = new Promise<void>((resolve) => {
    markOriginBStarted = resolve;
  });
  let originBResponse: ServerResponse | undefined;
  const origin = createServer((incoming, response) => {
    if (incoming.url === "/a") {
      markOriginAStarted();
      return;
    }
    if (incoming.url === "/b") {
      originBResponse = response;
      markOriginBStarted();
      return;
    }
    response.end("carrier-current");
  });
  const originPort = await listen(origin);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 5,
    authorizationQueryTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_000,
    carrierLeaseMs: 5_000,
  });
  const gatewayPort = await gateway.listen();
  const initial = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    carrierCredential: createCredential,
  });
  let resumed: ReturnType<typeof connectTunnelClient> | undefined;

  try {
    const activation = await initial.ready;
    const requestA = sendReviewerRequest(
      gatewayPort,
      `${tunnelId}.localhost`,
      "/a",
      "reviewer-a-cookie",
    );
    void requestA.catch(() => undefined);
    await originAStarted;
    await reviewerACheckStarted;

    await initial.disconnect();
    resumed = connectTunnelClient({
      gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId,
      localOrigin: `http://127.0.0.1:${originPort}`,
      resumeSecret: activation.resumeSecret,
      carrierCredential: resumeCredential,
    });
    assert.equal((await resumed.ready).generation, 2);

    const requestB = sendReviewerRequest(
      gatewayPort,
      `${tunnelId}.localhost`,
      "/b",
      "reviewer-b-cookie",
    );
    await originBStarted;
    resolveReviewerACheck(false);
    await delay(20);
    originBResponse?.end("reviewer-b-survived");
    const responseB = await withTestDeadline(requestB, "generation 2 reviewer stream stalled");
    assert.equal(responseB.statusCode, 200);
    assert.equal(responseB.body, "reviewer-b-survived");

    const current = await withTestDeadline(
      sendReviewerRequest(
        gatewayPort,
        `${tunnelId}.localhost`,
        "/current",
        "reviewer-b-cookie",
      ),
      "generation 2 Carrier was closed by stale revocation",
    );
    assert.equal(current.statusCode, 200);
    assert.equal(current.body, "carrier-current");
  } finally {
    resolveReviewerACheck(true);
    originBResponse?.end();
    await resumed?.disconnect().catch(() => undefined);
    await initial.disconnect().catch(() => undefined);
    await gateway.close();
    await close(origin);
  }
});

test("a failed heartbeat send from generation 1 cannot close generation 2", async () => {
  const originalSend = WebSocket.prototype.send;
  let markPingStarted!: () => void;
  const pingStarted = new Promise<void>((resolve) => {
    markPingStarted = resolve;
  });
  let failOldPing: ((error?: Error) => void) | undefined;
  let intercepted = false;
  WebSocket.prototype.send = function patchedSend(
    this: WebSocket,
    data: never,
    ...arguments_: never[]
  ) {
    try {
      const envelope = decodeEnvelope(Buffer.from(data));
      const callback = arguments_.at(-1);
      if (
        !intercepted &&
        envelope.type === FrameType.Ping &&
        envelope.generation === 1 &&
        typeof callback === "function"
      ) {
        intercepted = true;
        failOldPing = callback as (error?: Error) => void;
        markPingStarted();
        return;
      }
    } catch {
      // Non-protocol application frames use the original WebSocket implementation.
    }
    Reflect.apply(originalSend, this, [data, ...arguments_]);
  } as typeof WebSocket.prototype.send;

  const tunnelId = "heartbeat-epoch";
  const origin = createServer((_incoming, response) => response.end("generation-2-alive"));
  const originPort = await listen(origin);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    heartbeatIntervalMs: 20,
    carrierLeaseMs: 5_000,
  });
  const gatewayPort = await gateway.listen();
  const initial = connectTunnelClient({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
  });
  let resumed: ReturnType<typeof connectTunnelClient> | undefined;

  try {
    const activation = await initial.ready;
    await pingStarted;
    await initial.disconnect();
    resumed = connectTunnelClient({
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId,
      localOrigin: `http://127.0.0.1:${originPort}`,
      resumeSecret: activation.resumeSecret,
    });
    assert.equal((await resumed.ready).generation, 2);

    failOldPing?.(new Error("generation 1 send failed late"));
    await delay(30);
    const response = await withTestDeadline(
      sendReviewerRequest(gatewayPort, `${tunnelId}.localhost`, "/", undefined),
      "generation 2 Carrier was closed by generation 1 heartbeat failure",
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "generation-2-alive");
  } finally {
    WebSocket.prototype.send = originalSend;
    failOldPing?.();
    await resumed?.disconnect().catch(() => undefined);
    await initial.disconnect().catch(() => undefined);
    await gateway.close();
    await close(origin);
  }
});

test("one Tunnel authorization query failure does not close another Tunnel", async () => {
  const authService = createAuthService();
  const credentialA = "A".repeat(32);
  const credentialB = "B".repeat(32);
  authService.consumeCarrierCredential = async (token) => {
    const suffix = token === credentialA ? "a" : "b";
    return {
      accountId: `developer-${suffix}`,
      accountAuthVersion: 1,
      username: `developer-${suffix}`,
      purpose: "create",
      tunnelId: `isolated-${suffix}`,
    };
  };
  authService.resolveSession = async () => principal("reviewer", "reviewer-session");
  let rejectDeveloperA = false;
  setAuthorizationCheck(authService, async (accountId) => {
    if (rejectDeveloperA && accountId === "developer-a") {
      throw new Error("developer A authorization database failure");
    }
    return true;
  });

  const origin = createServer((_incoming, response) => response.end("isolated-b-alive"));
  const originPort = await listen(origin);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 5,
    authorizationQueryTimeoutMs: 100,
  });
  const gatewayPort = await gateway.listen();
  const clientA = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "isolated-a",
    localOrigin: `http://127.0.0.1:${originPort}`,
    carrierCredential: credentialA,
  });
  const clientB = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId: "isolated-b",
    localOrigin: `http://127.0.0.1:${originPort}`,
    carrierCredential: credentialB,
  });

  try {
    await Promise.all([clientA.ready, clientB.ready]);
    rejectDeveloperA = true;
    await withTestDeadline(clientA.closed, "Tunnel A did not fail closed");
    const response = await withTestDeadline(
      sendReviewerRequest(
        gatewayPort,
        "isolated-b.localhost",
        "/still-alive",
        "reviewer-cookie",
      ),
      "Tunnel B was closed by Tunnel A authorization failure",
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "isolated-b-alive");
  } finally {
    await clientA.disconnect().catch(() => undefined);
    await clientB.disconnect().catch(() => undefined);
    await gateway.close();
    await close(origin);
  }
});

test("timed-out authorization batch keeps its admission until settle", async () => {
  const authService = createAuthService();
  const tunnelByCredential = new Map<string, string>();
  authService.consumeCarrierCredential = async (token) => {
    const tunnelId = tunnelByCredential.get(token);
    if (tunnelId === undefined) throw new Error("unknown test credential");
    return {
      accountId: `developer-${tunnelId}`,
      accountAuthVersion: 1,
      username: `developer-${tunnelId}`,
      purpose: "create",
      tunnelId,
    };
  };
  let authorizationCalls = 0;
  let peakAuthorizations = 0;
  let activeAuthorizations = 0;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseAuthorizations!: () => void;
  const heldAuthorizations = new Promise<void>((resolve) => {
    releaseAuthorizations = resolve;
  });
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  let holdAuthorizationBatches = false;
  authService.areAccountsAuthorized = async (checks) => {
    if (!holdAuthorizationBatches) return checks.map(() => true);
    authorizationCalls += 1;
    activeAuthorizations += 1;
    peakAuthorizations = Math.max(peakAuthorizations, activeAuthorizations);
    if (authorizationCalls === 1) markFirstStarted();
    if (authorizationCalls === 2) markSecondStarted();
    await heldAuthorizations;
    activeAuthorizations -= 1;
    return checks.map(() => true);
  };

  const origin = createServer((_incoming, response) => response.end("ok"));
  const originPort = await listen(origin);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 5,
    authorizationQueryTimeoutMs: 20,
  });
  const gatewayPort = await gateway.listen();
  const clients: ReturnType<typeof connectTunnelClient>[] = [];

  try {
    for (let index = 0; index < 6; index += 1) {
      const tunnelId = `retained-${index}`;
      const credential = String(index).padStart(32, "K");
      tunnelByCredential.set(credential, tunnelId);
      clients.push(connectTunnelClient({
        gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
        tunnelId,
        localOrigin: `http://127.0.0.1:${originPort}`,
        carrierCredential: credential,
      }));
    }
    await Promise.all(clients.map((client) => client.ready));
    holdAuthorizationBatches = true;
    await withTestDeadline(firstStarted, "authorization batch did not start");
    await delay(50);
    assert.equal(authorizationCalls, 1, "deadline duplicated an unsettled batch query");
    assert.equal(peakAuthorizations, 1);
    await withTestDeadline(
      Promise.all(clients.map((client) => client.closed)).then(() => undefined),
      "capacity-limited sessions did not fail closed",
    );

    releaseAuthorizations();
    const finalTunnelId = "retained-after-settle";
    const finalCredential = "Z".repeat(32);
    tunnelByCredential.set(finalCredential, finalTunnelId);
    const finalClient = connectTunnelClient({
      gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId: finalTunnelId,
      localOrigin: `http://127.0.0.1:${originPort}`,
      carrierCredential: finalCredential,
    });
    clients.push(finalClient);
    await finalClient.ready;
    await withTestDeadline(secondStarted, "settled batch did not release admission");
  } finally {
    releaseAuthorizations();
    await Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)));
    await gateway.close();
    await close(origin);
  }
});

test("reviewer revalidation snapshots streams before awaiting account checks", async () => {
  const tunnelId = "revalidation-stream-snapshot";
  const authService = createAuthService();
  authService.consumeCarrierCredential = async () => ({
    accountId: "snapshot-developer",
    accountAuthVersion: 1,
    username: "snapshot-developer",
    purpose: "create",
    tunnelId,
  });
  authService.resolveSession = async () => principal("snapshot-reviewer", "snapshot-session");
  let reviewerChecks = 0;
  let markFirstReviewerCheck!: () => void;
  const firstReviewerCheck = new Promise<void>((resolve) => {
    markFirstReviewerCheck = resolve;
  });
  let releaseFirstReviewerCheck!: () => void;
  const heldFirstReviewerCheck = new Promise<void>((resolve) => {
    releaseFirstReviewerCheck = resolve;
  });
  setAuthorizationCheck(authService, async (_accountId, _authVersion, role) => {
    if (role === "DEVELOPER") return true;
    reviewerChecks += 1;
    if (reviewerChecks === 1) {
      markFirstReviewerCheck();
      await heldFirstReviewerCheck;
    }
    return true;
  });

  let markFirstOriginRequest!: () => void;
  const firstOriginRequest = new Promise<void>((resolve) => {
    markFirstOriginRequest = resolve;
  });
  let markSecondOriginRequest!: () => void;
  const secondOriginRequest = new Promise<void>((resolve) => {
    markSecondOriginRequest = resolve;
  });
  const originResponses = new Set<ServerResponse>();
  const origin = createServer((incoming, response) => {
    originResponses.add(response);
    response.once("close", () => originResponses.delete(response));
    if (incoming.url === "/first") markFirstOriginRequest();
    if (incoming.url === "/second") markSecondOriginRequest();
  });
  const originPort = await listen(origin);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 500,
    authorizationQueryTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_000,
  });
  const gatewayPort = await gateway.listen();
  const client = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    carrierCredential: "S".repeat(32),
  });

  try {
    await client.ready;
    const first = sendReviewerRequest(
      gatewayPort,
      `${tunnelId}.localhost`,
      "/first",
      "snapshot-cookie",
    );
    void first.catch(() => undefined);
    await firstOriginRequest;
    await withTestDeadline(firstReviewerCheck, "first reviewer check did not start");

    const second = sendReviewerRequest(
      gatewayPort,
      `${tunnelId}.localhost`,
      "/second",
      "snapshot-cookie",
    );
    void second.catch(() => undefined);
    await secondOriginRequest;
    releaseFirstReviewerCheck();

    await delay(100);
    assert.equal(
      reviewerChecks,
      1,
      "the in-progress cycle absorbed a stream appended after its snapshot",
    );
  } finally {
    releaseFirstReviewerCheck();
    for (const response of originResponses) response.destroy();
    await client.disconnect().catch(() => undefined);
    await gateway.close();
    await close(origin);
  }
});

test("a deferred reviewer RESET send does not block the next stream revalidation", async () => {
  const originalSend = WebSocket.prototype.send;
  let releaseDeferredReset: ((error?: Error) => void) | undefined;
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
        releaseDeferredReset === undefined &&
        typeof callback === "function"
      ) {
        releaseDeferredReset = callback as (error?: Error) => void;
        markResetAttempted();
        return;
      }
    } catch {
      // Non-Carrier bytes use the original WebSocket implementation.
    }
    Reflect.apply(originalSend, this, [data, ...arguments_]);
  } as typeof WebSocket.prototype.send;

  const tunnelId = "revalidation-reset-admission";
  const reviewerA = principal("reset-reviewer-a", "reset-session-a");
  const reviewerB = principal("reset-reviewer-b", "reset-session-b");
  const authService = createAuthService();
  authService.consumeCarrierCredential = async () => ({
    accountId: "reset-developer",
    accountAuthVersion: 1,
    username: "reset-developer",
    purpose: "create",
    tunnelId,
  });
  authService.resolveSession = async (token) =>
    token === "reset-cookie-a" ? reviewerA : reviewerB;
  let enforceRevocation = false;
  let markReviewerBChecked!: () => void;
  const reviewerBChecked = new Promise<void>((resolve) => {
    markReviewerBChecked = resolve;
  });
  setAuthorizationCheck(authService, async (accountId, _authVersion, role) => {
    if (!enforceRevocation || role === "DEVELOPER") return true;
    if (accountId === reviewerB.accountId) markReviewerBChecked();
    return accountId !== reviewerA.accountId;
  });

  let markOriginAStarted!: () => void;
  const originAStarted = new Promise<void>((resolve) => {
    markOriginAStarted = resolve;
  });
  let markOriginBStarted!: () => void;
  const originBStarted = new Promise<void>((resolve) => {
    markOriginBStarted = resolve;
  });
  const originResponses = new Set<ServerResponse>();
  const origin = createServer((incoming, response) => {
    originResponses.add(response);
    response.once("close", () => originResponses.delete(response));
    if (incoming.url === "/a") markOriginAStarted();
    if (incoming.url === "/b") markOriginBStarted();
  });
  const originPort = await listen(origin);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 100,
    authorizationQueryTimeoutMs: 1_000,
    heartbeatIntervalMs: 1_000,
  });
  const gatewayPort = await gateway.listen();
  const client = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    carrierCredential: "T".repeat(32),
  });

  try {
    await client.ready;
    const requestA = sendReviewerRequest(
      gatewayPort,
      `${tunnelId}.localhost`,
      "/a",
      "reset-cookie-a",
    );
    void requestA.catch(() => undefined);
    await originAStarted;
    const requestB = sendReviewerRequest(
      gatewayPort,
      `${tunnelId}.localhost`,
      "/b",
      "reset-cookie-b",
    );
    void requestB.catch(() => undefined);
    await originBStarted;
    enforceRevocation = true;

    await withTestDeadline(resetAttempted, "reviewer RESET send was not attempted");
    await withTestDeadline(
      reviewerBChecked,
      "deferred RESET send blocked the next reviewer authorization check",
    );
  } finally {
    releaseDeferredReset?.();
    WebSocket.prototype.send = originalSend;
    for (const response of originResponses) response.destroy();
    await client.disconnect().catch(() => undefined);
    await gateway.close();
    await close(origin);
  }
});

test("reviewer authorization completion cannot open work after server-observed connection cancellation", async () => {
  const tunnelId = "closed-reviewer-boundary";
  const reviewer = principal("closed-reviewer", "closed-reviewer-session");
  const authService = createAuthService();
  authService.consumeCarrierCredential = async () => ({
    accountId: "closed-reviewer-developer",
    accountAuthVersion: 1,
    username: "closed-reviewer-developer",
    purpose: "create",
    tunnelId,
  });
  type DeferredAuthorization = {
    readonly started: Promise<void>;
    readonly markStarted: () => void;
    readonly settled: Promise<void>;
    readonly settle: () => void;
  };
  const deferredAuthorizations: DeferredAuthorization[] = [];
  authService.resolveSession = async () => {
    const deferred = deferredAuthorizations.shift();
    if (deferred === undefined) return reviewer;
    deferred.markStarted();
    await deferred.settled;
    return reviewer;
  };
  setAuthorizationCheck(authService, async () => true);

  let originHttpRequests = 0;
  let originUpgrades = 0;
  const originSockets = new Set<import("node:net").Socket>();
  const origin = createServer(() => {
    originHttpRequests += 1;
  });
  origin.on("connection", (socket) => {
    originSockets.add(socket);
    socket.once("close", () => originSockets.delete(socket));
  });
  origin.on("upgrade", () => {
    originUpgrades += 1;
  });
  const originPort = await listen(origin);
  let markHttpCancellation!: () => void;
  const httpCancellation = new Promise<void>((resolve) => {
    markHttpCancellation = resolve;
  });
  let markUpgradeCancellation!: () => void;
  const upgradeCancellation = new Promise<void>((resolve) => {
    markUpgradeCancellation = resolve;
  });
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    secureCookies: false,
    authorizationCheckIntervalMs: 1_000,
    heartbeatIntervalMs: 1_000,
    logger(event) {
      if (event.event !== "reviewer.authorization_cancelled") return;
      if (event.reason === "http") markHttpCancellation();
      if (event.reason === "upgrade") markUpgradeCancellation();
    },
  });
  const gatewayPort = await gateway.listen();
  const client = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    carrierCredential: "U".repeat(32),
  });
  const deferAuthorization = (): DeferredAuthorization => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { started, markStarted, settled, settle };
  };

  try {
    await client.ready;

    const deferredHttp = deferAuthorization();
    deferredAuthorizations.push(deferredHttp);
    const outgoing = request({
      host: "127.0.0.1",
      port: gatewayPort,
      path: "/closed-http",
      headers: {
        host: `${tunnelId}.localhost`,
        cookie: "rt_session_dev=closed-http-cookie",
      },
    });
    outgoing.once("error", () => undefined);
    outgoing.end();
    await deferredHttp.started;
    outgoing.destroy();
    await withTestDeadline(httpCancellation, "Gateway did not observe the closed HTTP connection");
    deferredHttp.settle();
    await delay(50);

    const deferredUpgrade = deferAuthorization();
    deferredAuthorizations.push(deferredUpgrade);
    const webSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/closed-websocket`, {
      headers: {
        host: `${tunnelId}.localhost`,
        cookie: "rt_session_dev=closed-websocket-cookie",
      },
    });
    webSocket.once("error", () => undefined);
    await deferredUpgrade.started;
    webSocket.terminate();
    await withTestDeadline(
      upgradeCancellation,
      "Gateway did not observe the closed reviewer WebSocket",
    );
    deferredUpgrade.settle();
    await delay(50);

    assert.equal(originHttpRequests, 0);
    assert.equal(originUpgrades, 0);
  } finally {
    for (const deferred of deferredAuthorizations) deferred.settle();
    await client.disconnect().catch(() => undefined);
    await gateway.close();
    for (const socket of originSockets) socket.destroy();
    await close(origin);
  }
});

test("stale SessionActive completion cannot clear a resumed activation timer", async () => {
  const originalSend = WebSocket.prototype.send;
  let settleGenerationOneActive: ((error?: Error) => void) | undefined;
  WebSocket.prototype.send = function patchedSend(
    this: WebSocket,
    data: never,
    ...arguments_: never[]
  ) {
    try {
      const envelope = decodeEnvelope(Buffer.from(data));
      const callback = arguments_.at(-1);
      if (
        settleGenerationOneActive === undefined &&
        envelope.type === FrameType.SessionActive &&
        envelope.generation === 1 &&
        typeof callback === "function"
      ) {
        Reflect.apply(originalSend, this, [data]);
        settleGenerationOneActive = callback as (error?: Error) => void;
        return;
      }
    } catch {
      // Non-Carrier bytes use the original WebSocket implementation.
    }
    Reflect.apply(originalSend, this, [data, ...arguments_]);
  } as typeof WebSocket.prototype.send;

  const tunnelId = "activation-epoch";
  const origin = createServer((_incoming, response) => response.end("ok"));
  const originPort = await listen(origin);
  const localOrigin = `http://127.0.0.1:${originPort}`;
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    activationTimeoutMs: 200,
    heartbeatIntervalMs: 1_000,
  });
  const gatewayPort = await gateway.listen();
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`;
  const initial = connectTunnelClient({ gatewayUrl, tunnelId, localOrigin });
  let resumed: WebSocket | undefined;

  try {
    const activation = await initial.ready;
    assert.ok(settleGenerationOneActive !== undefined);
    await initial.disconnect();

    resumed = new WebSocket(gatewayUrl, CARRIER_PROFILE);
    await once(resumed, "open");
    const configReceived = nextCarrierEnvelope(resumed, FrameType.SessionConfig);
    resumed.send(encodeEnvelope({
      type: FrameType.Hello,
      flags: 0,
      generation: 0,
      streamId: 0,
      payload: encodeMetadata({
        mode: "resume",
        tunnelId,
        resumeSecret: activation.resumeSecret,
        localOriginFingerprint: createHash("sha256")
          .update("review-tunnel.v1.local-origin\0", "utf8")
          .update(localOrigin, "utf8")
          .digest("base64url"),
        originProjection: "local-view",
      }),
    }));
    await configReceived;
    const closed = once(resumed, "close") as Promise<[number, Buffer]>;
    settleGenerationOneActive();
    const [code] = await Promise.race([
      closed,
      delay(600).then(() => {
        throw new Error("stale SessionActive completion cleared generation 2 timeout");
      }),
    ]);
    assert.equal(code, 1008);
  } finally {
    WebSocket.prototype.send = originalSend;
    settleGenerationOneActive?.();
    resumed?.terminate();
    await initial.disconnect().catch(() => undefined);
    await gateway.close();
    await close(origin);
  }
});

function createAuthService(): AuthService {
  return new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new EpochTestHasher(),
    sessionHmacKey: Buffer.alloc(32, 31),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: { write() {}, reportFailure() {} },
  });
}

function setAuthorizationCheck(
  service: AuthService,
  check: AuthService["isAccountAuthorized"],
): void {
  service.isAccountAuthorized = check;
  service.areAccountsAuthorized = (checks) => Promise.all(checks.map((input) =>
    check(input.accountId, input.accountAuthVersion, input.role)));
}

function principal(accountId: string, sessionId: string): Principal {
  return {
    accountId,
    username: accountId,
    displayName: accountId,
    roles: ["REVIEWER"],
    mustChangePassword: false,
    authVersion: 1,
    sessionId,
  };
}

function sendReviewerRequest(
  port: number,
  host: string,
  path: string,
  cookie: string | undefined,
): Promise<Readonly<{ statusCode: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        host,
        accept: "application/json",
        ...(cookie === undefined ? {} : { cookie: `rt_session_dev=${cookie}` }),
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => resolve({
        statusCode: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function withTestDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    operation,
    delay(1_000).then(() => {
      throw new Error(message);
    }),
  ]);
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

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
