import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { test } from "node:test";

import {
  AuthService,
  InMemoryAuthRepository,
  type PasswordHasher,
} from "../../../packages/auth/src/index.ts";
import {
  InMemoryReviewRepository,
  createReviewService,
} from "../../../packages/review/src/index.ts";
import { connectTunnelClient, type TunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "./server.ts";

class TestHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

const DISCARD_AUTHENTICATION_EVENTS = { write() {}, reportFailure() {} };

test("authenticated review APIs bind stable revisions and never reach the local app", async () => {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 8),
    dummyPasswordHash: "hashed:dummy-password",
    authenticationEventSink: DISCARD_AUTHENTICATION_EVENTS,
  });
  const bootstrap = await authService.bootstrapAdministrator({
    username: "developer",
    displayName: "Developer",
  });
  const temporaryDeveloper = await authService.authenticate({
    username: "developer",
    password: bootstrap.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await authService.changeOwnPassword(temporaryDeveloper.principal, {
    currentPassword: bootstrap.temporaryPassword,
    newPassword: "developer-password-2026",
  });
  let developer = await authService.authenticate({
    username: "developer",
    password: "developer-password-2026",
    remoteAddress: "127.0.0.1",
  });
  await authService.setAccountRoles(
    developer.principal,
    developer.principal.accountId,
    ["ADMIN", "DEVELOPER"],
  );
  developer = await authService.authenticate({
    username: "developer",
    password: "developer-password-2026",
    remoteAddress: "127.0.0.1",
  });
  const reviewerAccount = await authService.createAccount(developer.principal, {
    username: "reviewer",
    displayName: "Reviewer",
    roles: ["REVIEWER"],
  });
  const temporaryReviewer = await authService.authenticate({
    username: "reviewer",
    password: reviewerAccount.temporaryPassword,
    remoteAddress: "127.0.0.1",
  });
  await authService.changeOwnPassword(temporaryReviewer.principal, {
    currentPassword: reviewerAccount.temporaryPassword,
    newPassword: "reviewer-password-2026",
  });
  const reviewer = await authService.authenticate({
    username: "reviewer",
    password: "reviewer-password-2026",
    remoteAddress: "127.0.0.1",
  });

  const localPaths: string[] = [];
  const origin = createServer((incoming, response) => {
    localPaths.push(incoming.url ?? "/");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Local app</title>");
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originAddress = origin.address();
  assert.ok(originAddress !== null && typeof originAddress !== "string");

  const reviewRepository = new InMemoryReviewRepository();
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    reviewService: createReviewService({ repository: reviewRepository }),
    reviewEventStreamPolicy: {
      pollIntervalMs: 10,
      heartbeatIntervalMs: 20,
      retryMs: 5,
      maxConnections: 4,
      maxConnectionsPerAccount: 1,
    },
    secureCookies: false,
  });
  const gatewayPort = await gateway.listen();
  const clients: TunnelClient[] = [];
  const eventStreams: ReviewEventStreamClient[] = [];
  let shutdown: Promise<void> | undefined;
  let releaseCleanup: (() => void) | undefined;
  try {
    const first = await startTunnel(
      authService,
      developer.principal,
      gatewayPort,
      originAddress.port,
      "review-tunnel-one",
    );
    clients.push(first.client);
    const firstHost = `${first.tunnelId}.localhost`;
    const contentCookie = await issueContentCookie(authService, reviewer.principal, firstHost);

    const unauthenticated = await send(gatewayPort, firstHost, "/_review-tunnel/review/context", {
      method: "GET",
      headers: {},
    });
    assert.equal(unauthenticated.status, 401);
    const unknownUnauthenticated = await send(
      gatewayPort,
      "unknown-review-tunnel.localhost",
      "/_review-tunnel/review/context",
      { method: "GET", headers: {} },
    );
    assert.equal(unknownUnauthenticated.status, unauthenticated.status);
    const beforeBinding = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/bootstrap.js",
      { method: "GET", headers: { cookie: contentCookie } },
    );
    assert.equal(beforeBinding.status, 404);

    const rejectedReviewerBinding = await send(
      gatewayPort,
      "control.localhost",
      `/api/client/review-bindings/${first.tunnelId}`,
      {
        method: "PUT",
        headers: {
          "x-review-tunnel-client": "1",
          authorization: `Bearer ${reviewer.sessionToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          projectSlug: "storefront",
          revisionKey: "commit-a",
        }).toString(),
      },
    );
    assert.equal(rejectedReviewerBinding.status, 403);

    const binding = await bindReview(
      gatewayPort,
      developer.sessionToken,
      first.tunnelId,
      "storefront",
      "commit-a",
    );
    assert.equal(binding.status, 200);
    const bootstrapAsset = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/bootstrap.js",
      { method: "GET", headers: { cookie: contentCookie } },
    );
    assert.equal(bootstrapAsset.status, 200);
    assert.match(bootstrapAsset.headers["content-type"] ?? "", /application\/javascript/);
    assert.equal(bootstrapAsset.headers["cache-control"], "no-store");
    assert.match(bootstrapAsset.body, /attachShadow/);

    const context = await send(gatewayPort, firstHost, "/_review-tunnel/review/context", {
      method: "GET",
      headers: { cookie: contentCookie },
    });
    assert.equal(context.status, 200);
    assert.deepEqual(JSON.parse(context.body), {
      project: { slug: "storefront", displayName: "storefront" },
      revision: { key: "commit-a" },
      principal: {
        username: "reviewer",
        displayName: "Reviewer",
        canComment: true,
        canManageProject: false,
      },
    });
    const developerContentCookie = await issueContentCookie(
      authService,
      developer.principal,
      firstHost,
    );
    const developerContext = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/context",
      { method: "GET", headers: { cookie: developerContentCookie } },
    );
    assert.equal(developerContext.status, 200);
    assert.equal(JSON.parse(developerContext.body).principal.canManageProject, true);

    const invalidEventCursor = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/events?path=%2Fproducts",
      {
        method: "GET",
        headers: { cookie: contentCookie, "last-event-id": "01" },
      },
    );
    assert.equal(invalidEventCursor.status, 400);
    const wrongEventOrigin = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/events?path=%2Fproducts",
      {
        method: "GET",
        headers: { cookie: contentCookie, origin: "http://attacker.example" },
      },
    );
    assert.equal(wrongEventOrigin.status, 403);
    const reviewEvents = await openReviewEventStream(
      gatewayPort,
      firstHost,
      "/products",
      contentCookie,
    );
    eventStreams.push(reviewEvents);
    assert.match(reviewEvents.contentType, /text\/event-stream/);
    assert.equal(reviewEvents.cacheControl, "no-store");
    await reviewEvents.nextHeartbeat();
    const connectionLimited = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/events?path=%2Fcart",
      { method: "GET", headers: { cookie: contentCookie } },
    );
    assert.equal(connectionLimited.status, 429);

    const wrongOrigin = await send(gatewayPort, firstHost, "/_review-tunnel/review/comments", {
      method: "POST",
      headers: {
        cookie: contentCookie,
        origin: "http://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "/products", body: "blocked" }),
    });
    assert.equal(wrongOrigin.status, 403);

    const oversized = await send(gatewayPort, firstHost, "/_review-tunnel/review/comments", {
      method: "POST",
      headers: {
        cookie: contentCookie,
        origin: new URL(first.shareUrl).origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "/products", body: "x".repeat(9_000) }),
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(JSON.parse(oversized.body), { error: "INVALID_REVIEW_INPUT" });

    const created = await send(gatewayPort, firstHost, "/_review-tunnel/review/comments", {
      method: "POST",
      headers: {
        cookie: contentCookie,
        origin: new URL(first.shareUrl).origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "/products",
        body: "@developer <img src=x onerror=alert(1)>",
      }),
    });
    assert.equal(created.status, 201);
    const createdComment = JSON.parse(created.body).comment;
    assert.equal(createdComment.body, "@developer <img src=x onerror=alert(1)>");
    assert.deepEqual(createdComment.anchor, { type: "PAGE" });
    assert.deepEqual(createdComment.replies, []);
    assert.equal(created.headers["cache-control"], "no-store");
    const createdEvent = await reviewEvents.nextEvent();
    assert.equal(createdEvent.type, "COMMENT_CREATED");
    assert.equal(createdEvent.threadId, createdComment.id);

    const developerNotifications = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/notifications?path=%2Fproducts",
      { method: "GET", headers: { cookie: developerContentCookie } },
    );
    assert.equal(developerNotifications.status, 200);
    const developerNotification = JSON.parse(developerNotifications.body).notifications[0];
    assert.equal(developerNotification.actor.accountId, reviewer.principal.accountId);
    assert.equal(developerNotification.readAt, null);
    const hiddenReviewerNotifications = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/notifications?path=%2Fproducts",
      { method: "GET", headers: { cookie: contentCookie } },
    );
    assert.deepEqual(JSON.parse(hiddenReviewerNotifications.body), { notifications: [] });
    const markedRead = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/notifications/${developerNotification.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: developerContentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/products", read: true }),
      },
    );
    assert.equal(markedRead.status, 200);
    assert.equal(typeof JSON.parse(markedRead.body).notification.readAt, "string");
    const crossAccountRead = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/notifications/${developerNotification.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/products", read: true }),
      },
    );
    assert.equal(crossAccountRead.status, 404);

    const regionCreated = await send(gatewayPort, firstHost, "/_review-tunnel/review/comments", {
      method: "POST",
      headers: {
        cookie: contentCookie,
        origin: new URL(first.shareUrl).origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "/products",
        body: "Pinned visual feedback",
        anchor: {
          type: "REGION_V1",
          selection: "POINT",
          x: 0.25,
          y: 0.5,
          width: 0,
          height: 0,
          document: { width: 1280, height: 2400 },
          viewport: { width: 1280, height: 720 },
        },
      }),
    });
    assert.equal(regionCreated.status, 201);
    assert.equal(JSON.parse(regionCreated.body).comment.anchor.type, "REGION_V1");
    assert.equal(JSON.parse(regionCreated.body).comment.pinNumber, 1);
    const regionEvent = await reviewEvents.nextEvent();
    assert.equal(regionEvent.type, "COMMENT_CREATED");
    assert.notEqual(regionEvent.id, createdEvent.id);

    await reviewEvents.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replayedEvents = await openReviewEventStream(
      gatewayPort,
      firstHost,
      "/products",
      contentCookie,
      createdEvent.id,
    );
    eventStreams.push(replayedEvents);
    assert.deepEqual(await replayedEvents.nextEvent(), regionEvent);
    await replayedEvents.close();

    const editedComment = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedVersion: 1,
          body: "Edited reviewer comment",
        }),
      },
    );
    assert.equal(editedComment.status, 200);
    assert.equal(JSON.parse(editedComment.body).comment.version, 2);
    const staleCommentEdit = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedVersion: 1,
          body: "Stale edit",
        }),
      },
    );
    assert.equal(staleCommentEdit.status, 409);
    assert.deepEqual(JSON.parse(staleCommentEdit.body), { error: "REVIEW_VERSION_CONFLICT" });
    const otherAuthorEdit = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: developerContentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedVersion: 2,
          body: "Developer cannot rewrite reviewer text",
        }),
      },
    );
    assert.equal(otherAuthorEdit.status, 403);

    const hiddenOtherPath = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/replies`,
      {
        method: "POST",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/cart", body: "must remain hidden" }),
      },
    );
    assert.equal(hiddenOtherPath.status, 404);

    const replyCreated = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/replies`,
      {
        method: "POST",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          body: '<svg onload="window.replyXss=1">Reviewer reply',
        }),
      },
    );
    assert.equal(replyCreated.status, 201);
    assert.equal(
      JSON.parse(replyCreated.body).reply.body,
      '<svg onload="window.replyXss=1">Reviewer reply',
    );
    const createdReply = JSON.parse(replyCreated.body).reply;
    const listedReplies = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/replies?path=%2Fproducts`,
      { method: "GET", headers: { cookie: contentCookie } },
    );
    assert.equal(listedReplies.status, 200);
    assert.deepEqual(JSON.parse(listedReplies.body).pageInfo, { hasMore: false });
    assert.equal(JSON.parse(listedReplies.body).replies[0].id, createdReply.id);
    const editedReply = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/replies/${createdReply.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedVersion: 1,
          body: "Edited reviewer reply",
        }),
      },
    );
    assert.equal(editedReply.status, 200);
    assert.equal(JSON.parse(editedReply.body).reply.version, 2);

    const rejectedReviewerResolve = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/status`,
      {
        method: "PATCH",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedStatus: "OPEN",
          status: "RESOLVED",
        }),
      },
    );
    assert.equal(rejectedReviewerResolve.status, 403);

    const resolved = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/status`,
      {
        method: "PATCH",
        headers: {
          cookie: developerContentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedStatus: "OPEN",
          status: "RESOLVED",
        }),
      },
    );
    assert.equal(resolved.status, 200);
    assert.equal(JSON.parse(resolved.body).comment.status, "RESOLVED");

    const replyToResolved = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/replies`,
      {
        method: "POST",
        headers: {
          cookie: contentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/products", body: "too late" }),
      },
    );
    assert.equal(replyToResolved.status, 409);
    assert.deepEqual(JSON.parse(replyToResolved.body), { error: "REVIEW_STATE_CONFLICT" });

    const staleResolve = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/status`,
      {
        method: "PATCH",
        headers: {
          cookie: developerContentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedStatus: "OPEN",
          status: "RESOLVED",
        }),
      },
    );
    assert.equal(staleResolve.status, 409);

    const reopened = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/status`,
      {
        method: "PATCH",
        headers: {
          cookie: developerContentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "/products",
          expectedStatus: "RESOLVED",
          status: "OPEN",
        }),
      },
    );
    assert.equal(reopened.status, 200);
    assert.equal(JSON.parse(reopened.body).comment.status, "OPEN");

    const deletedReply = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}/replies/${createdReply.id}`,
      {
        method: "DELETE",
        headers: {
          cookie: developerContentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/products", expectedVersion: 2 }),
      },
    );
    if (deletedReply.status !== 200) {
      throw new Error(`reply delete failed ${deletedReply.status}: ${deletedReply.body}`);
    }
    assert.equal(JSON.parse(deletedReply.body).reply.body, null);
    const deletedComment = await send(
      gatewayPort,
      firstHost,
      `/_review-tunnel/review/comments/${createdComment.id}`,
      {
        method: "DELETE",
        headers: {
          cookie: developerContentCookie,
          origin: new URL(first.shareUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/products", expectedVersion: 2 }),
      },
    );
    assert.equal(deletedComment.status, 200, deletedComment.body);
    assert.equal(JSON.parse(deletedComment.body).comment.body, null);

    const listed = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/comments?path=%2Fproducts",
      { method: "GET", headers: { cookie: contentCookie } },
    );
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listed.body).comments.length, 2);
    assert.equal(JSON.parse(listed.body).comments[0].replies.length, 1);
    assert.equal(JSON.parse(listed.body).comments[0].body, null);
    assert.equal(JSON.parse(listed.body).comments[0].replies[0].body, null);
    assert.equal(JSON.parse(listed.body).openCount, 1);
    assert.equal(typeof JSON.parse(listed.body).eventCursor, "string");
    assert.deepEqual(JSON.parse(listed.body).pageInfo, { hasMore: false });
    const otherPath = await send(
      gatewayPort,
      firstHost,
      "/_review-tunnel/review/comments?path=%2Fcart",
      { method: "GET", headers: { cookie: contentCookie } },
    );
    assert.deepEqual(JSON.parse(otherPath.body), {
      comments: [],
      openCount: 0,
      eventCursor: "0",
      pageInfo: { hasMore: false },
    });

    const localApp = await send(gatewayPort, firstHost, "/products", {
      method: "GET",
      headers: { cookie: contentCookie },
    });
    assert.equal(localApp.status, 200);
    assert.deepEqual(localPaths, ["/products"]);

    await first.client.close();
    const second = await startTunnel(
      authService,
      developer.principal,
      gatewayPort,
      originAddress.port,
      "review-tunnel-two",
    );
    clients.push(second.client);
    assert.equal((await bindReview(
      gatewayPort,
      developer.sessionToken,
      second.tunnelId,
      "storefront",
      "commit-a",
    )).status, 200);
    const secondHost = `${second.tunnelId}.localhost`;
    const secondCookie = await issueContentCookie(authService, reviewer.principal, secondHost);
    const persisted = await send(
      gatewayPort,
      secondHost,
      "/_review-tunnel/review/comments?path=%2Fproducts",
      { method: "GET", headers: { cookie: secondCookie } },
    );
    assert.equal(JSON.parse(persisted.body).comments.length, 2);
    assert.equal(reviewRepository.projects.size, 1);
    assert.equal(reviewRepository.revisions.size, 1);
    assert.equal(reviewRepository.bindings.size, 1);

    // A disconnected tunnel has already left the session map, but its database
    // cleanup must still finish before Gateway shutdown can close the DB pool.
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupGate = Promise.withResolvers<void>();
    releaseCleanup = cleanupGate.resolve;
    const removeBinding = reviewRepository.removeTunnelBinding.bind(reviewRepository);
    reviewRepository.removeTunnelBinding = async (binding) => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
      await removeBinding(binding);
    };
    await second.client.close();
    await withTestTimeout(cleanupStarted.promise);
    let shutdownFinished = false;
    shutdown = gateway.close().then(() => { shutdownFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(shutdownFinished, false, "shutdown must wait for pending review cleanup");
    assert.equal(reviewRepository.bindings.size, 1);
    releaseCleanup();
    await withTestTimeout(shutdown);
    assert.equal(reviewRepository.bindings.size, 0);
  } finally {
    await Promise.all(eventStreams.map((stream) => stream.close().catch(() => undefined)));
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    releaseCleanup?.();
    await (shutdown ?? gateway.close());
    origin.close();
    await once(origin, "close");
  }
});

type ReviewEventMessage = Readonly<{
  id: string;
  type: string;
  threadId: string;
  actor: Readonly<{ accountId: string; displayName: string }>;
  occurredAt: string;
}>;

type ReviewEventStreamClient = Readonly<{
  contentType: string;
  cacheControl: string;
  nextEvent(): Promise<ReviewEventMessage>;
  nextHeartbeat(): Promise<void>;
  close(): Promise<void>;
}>;

function openReviewEventStream(
  port: number,
  host: string,
  routePath: string,
  cookie: string,
  lastEventId?: string,
): Promise<ReviewEventStreamClient> {
  return new Promise((resolve, reject) => {
    const eventQueue: ReviewEventMessage[] = [];
    const heartbeatQueue: undefined[] = [];
    const eventWaiters: Array<(event: ReviewEventMessage) => void> = [];
    const heartbeatWaiters: Array<() => void> = [];
    let buffer = "";
    let incomingResponse: import("node:http").IncomingMessage | undefined;
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: `/_review-tunnel/review/events?path=${encodeURIComponent(routePath)}`,
      method: "GET",
      headers: {
        host,
        cookie,
        accept: "text/event-stream",
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
    }, (response) => {
      incomingResponse = response;
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`review event stream failed: ${response.statusCode}`));
        return;
      }
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk.replace(/\r/g, "");
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith(":")) {
            const waiter = heartbeatWaiters.shift();
            if (waiter === undefined) heartbeatQueue.push(undefined);
            else waiter();
            continue;
          }
          const fields = new Map<string, string>();
          for (const line of block.split("\n")) {
            const separator = line.indexOf(":");
            if (separator < 0) continue;
            fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
          }
          if (fields.get("event") !== "review" || fields.get("data") === undefined) continue;
          const event = JSON.parse(fields.get("data")!) as ReviewEventMessage;
          const waiter = eventWaiters.shift();
          if (waiter === undefined) eventQueue.push(event);
          else waiter(event);
        }
      });
      const nextEvent = (): Promise<ReviewEventMessage> => {
        const queued = eventQueue.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return withTestTimeout(new Promise((eventResolve) => eventWaiters.push(eventResolve)));
      };
      const nextHeartbeat = (): Promise<void> => {
        if (heartbeatQueue.length > 0) {
          heartbeatQueue.shift();
          return Promise.resolve();
        }
        return withTestTimeout(new Promise((heartbeatResolve) =>
          heartbeatWaiters.push(heartbeatResolve)));
      };
      resolve({
        contentType: String(response.headers["content-type"] ?? ""),
        cacheControl: String(response.headers["cache-control"] ?? ""),
        nextEvent,
        nextHeartbeat,
        close() {
          if (response.destroyed) return Promise.resolve();
          return new Promise<void>((closeResolve) => {
            response.once("close", closeResolve);
            outgoing.destroy();
            response.destroy();
          });
        },
      });
    });
    outgoing.once("error", (error) => {
      if (incomingResponse === undefined) reject(error);
    });
    outgoing.end();
  });
}

function withTestTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("review event stream timed out")), 2_000);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startTunnel(
  authService: AuthService,
  developer: Parameters<AuthService["issueCarrierCredential"]>[0],
  gatewayPort: number,
  originPort: number,
  tunnelId: string,
) {
  const carrierCredential = await authService.issueCarrierCredential(developer, {
    purpose: "create",
    tunnelId,
  });
  const client = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin: `http://127.0.0.1:${originPort}`,
    carrierCredential,
  });
  const activation = await client.ready;
  return { client, tunnelId, shareUrl: activation.shareUrl };
}

async function issueContentCookie(
  authService: AuthService,
  reviewer: Parameters<AuthService["createSessionExchange"]>[0],
  host: string,
): Promise<string> {
  const intent = await authService.createLoginIntent(host, "/");
  const exchange = await authService.createSessionExchange(reviewer, intent);
  const content = await authService.consumeSessionExchange(exchange.code, host);
  return `rt_session_dev=${encodeURIComponent(content.sessionToken)}`;
}

function bindReview(
  port: number,
  sessionToken: string,
  tunnelId: string,
  projectSlug: string,
  revisionKey: string,
) {
  return send(port, "control.localhost", `/api/client/review-bindings/${tunnelId}`, {
    method: "PUT",
    headers: {
      "x-review-tunnel-client": "1",
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ projectSlug, revisionKey }).toString(),
  });
}

function send(
  port: number,
  host: string,
  path: string,
  input: Readonly<{
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Promise<Readonly<{
  status: number;
  body: string;
  headers: import("node:http").IncomingHttpHeaders;
}>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      method: input.method,
      headers: {
        host,
        accept: "application/json",
        ...input.headers,
        ...(input.body === undefined
          ? {}
          : { "content-length": String(Buffer.byteLength(input.body)) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(input.body);
  });
}
