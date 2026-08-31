import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { createServer, request } from "node:http";

import {
  AuthService,
  InMemoryAuthRepository,
} from "../../packages/auth/src/index.ts";
import {
  InMemoryReviewRepository,
  createReviewService,
} from "../../packages/review/src/index.ts";
import { connectTunnelClient } from "../../apps/client/src/client.ts";
import { createGatewayServer } from "../../apps/gateway/src/server.ts";

const DISCARD_AUTHENTICATION_EVENTS = { write() {}, reportFailure() {} };

class TestHasher {
  async hash(password) {
    return `hashed:${password}`;
  }

  async verify(hash, password) {
    return hash === `hashed:${password}`;
  }
}

test("Shadow DOM review overlay works with strict nonce CSP and survives API failure", async ({ page }) => {
  const runtime = await startReviewRuntime();
  try {
    await page.context().addCookies([{
      name: "rt_session_dev",
      value: runtime.contentSessionToken,
      url: runtime.shareUrl,
    }]);
    await page.goto(runtime.shareUrl);
    await expect(page.getByRole("heading", { name: "Review fixture app" })).toBeVisible();

    const overlay = page.locator("review-tunnel-overlay");
    await expect(overlay.getByRole("heading", { name: "Page review" })).toBeVisible();
    await expect(overlay.getByRole("status")).toHaveText("No comments on this page");
    const peerPage = await page.context().newPage();
    await peerPage.goto(runtime.shareUrl);
    const peerOverlay = peerPage.locator("review-tunnel-overlay");
    await expect(peerOverlay.getByRole("status")).toHaveText("No comments on this page");
    await overlay.getByRole("textbox", { name: "Comment", exact: true }).fill(
      '@developer <img src=x onerror="window.reviewTunnelXss=1"> home feedback',
    );
    await overlay.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(overlay.getByRole("status")).toHaveText("1 open · 1 loaded");
    const homeThread = overlay.locator(".thread").first();
    await expect(homeThread).toContainText("home feedback");
    await expect(peerOverlay.locator(".thread")).toContainText("home feedback");
    await peerPage.close();
    expect(await page.evaluate(() => window.reviewTunnelXss)).toBeUndefined();
    await homeThread.getByRole("textbox", { name: "Reply to comment" }).fill(
      '<svg onload="window.reviewTunnelReplyXss=1"> reviewer reply',
    );
    await homeThread.getByRole("button", { name: "Reply" }).click();
    await expect(homeThread.locator(".reply")).toContainText("reviewer reply");
    expect(await page.evaluate(() => window.reviewTunnelReplyXss)).toBeUndefined();

    page.once("dialog", (dialog) => dialog.accept("edited home feedback"));
    await homeThread.getByRole("button", { name: "Edit comment" }).click();
    await expect(homeThread).toContainText("edited home feedback");
    runtime.conflictNextContentMutation();
    page.once("dialog", (dialog) => dialog.accept("stale home feedback"));
    await homeThread.getByRole("button", { name: "Edit comment" }).click();
    await expect(overlay.getByRole("status")).toContainText("REVIEW_VERSION_CONFLICT");

    page.once("dialog", (dialog) => dialog.accept("edited reviewer reply"));
    await homeThread.getByRole("button", { name: "Edit reply" }).click();
    await expect(homeThread.locator(".reply")).toContainText("edited reviewer reply");
    page.once("dialog", (dialog) => dialog.accept());
    await homeThread.getByRole("button", { name: "Delete reply" }).click();
    await expect(homeThread.locator(".reply")).toContainText("Deleted reply");

    await overlay.getByRole("button", { name: "Select area or pin" }).click();
    await page.keyboard.press("Escape");
    await expect(overlay.locator(".selection-state")).toHaveText("Page comment");

    await overlay.getByRole("button", { name: "Select area or pin" }).click();
    await page.mouse.click(160, 180);
    await expect(overlay.locator(".selection-state")).toHaveText("Pinned point selected");
    await overlay.getByRole("textbox", { name: "Comment", exact: true }).fill("pinned feedback");
    await overlay.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(overlay.getByRole("status")).toHaveText("2 open · 2 loaded");
    await expect(overlay.locator(".marker.point")).toHaveCount(1);
    await expect(overlay.locator(".marker.point")).toHaveText("1");
    const pinnedThread = overlay.locator(".thread").filter({ hasText: "pinned feedback" });
    await expect(pinnedThread).toContainText("Pin #1 · Point");
    await overlay.getByRole("button", { name: "Open pin 1 comment" }).click();
    await expect(pinnedThread).toHaveClass(/active/);

    await overlay.getByRole("button", { name: "Select area or pin" }).click();
    await page.mouse.move(120, 300);
    await page.mouse.down();
    await page.mouse.move(260, 390, { steps: 4 });
    await page.mouse.up();
    await expect(overlay.locator(".selection-state")).toHaveText("Area selected");
    await overlay.getByRole("textbox", { name: "Comment", exact: true }).fill("selected area feedback");
    await overlay.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(overlay.getByRole("status")).toHaveText("3 open · 3 loaded");
    await expect(overlay.locator(".marker.rect")).toHaveCount(1);
    await expect(overlay.locator(".marker.rect")).toHaveText("2");
    await expect(overlay.locator(".thread").filter({ hasText: "selected area feedback" })).toContainText("Pin #2 · Area");

    await page.context().addCookies([{
      name: "rt_session_dev",
      value: runtime.developerContentSessionToken,
      url: runtime.shareUrl,
    }]);
    await page.reload();
    const developerOverlay = page.locator("review-tunnel-overlay");
    const notificationPanel = developerOverlay.locator(".notification-panel");
    await expect(notificationPanel.locator("summary")).toHaveText("Notifications (1 unread)");
    await notificationPanel.locator("summary").click();
    await expect(notificationPanel.locator(".notification")).toContainText("Reviewer mentioned you");
    await notificationPanel.getByRole("button", { name: "Mark read" }).click();
    await expect(notificationPanel.locator("summary")).toHaveText("Notifications (0 unread)");
    const developerThread = developerOverlay.locator(".thread").first();
    await developerThread.getByRole("button", { name: "Resolve" }).click();
    await expect(developerThread.locator(".thread-status")).toHaveText("Resolved");
    await expect(developerThread.getByRole("button", { name: "Reopen" })).toBeVisible();
    await expect(developerThread.getByRole("textbox", { name: "Reply to comment" })).toHaveCount(0);
    await developerThread.getByRole("button", { name: "Reopen" }).click();
    await expect(developerThread.locator(".thread-status")).toHaveText("Open");
    await expect(developerThread.getByRole("textbox", { name: "Reply to comment" })).toBeVisible();

    runtime.conflictNextStatusChange();
    await developerThread.getByRole("button", { name: "Resolve" }).click();
    await expect(developerOverlay.getByRole("status")).toContainText("REVIEW_STATE_CONFLICT");
    await expect(page.getByRole("heading", { name: "Review fixture app" })).toBeVisible();

    const developerPinnedThread = developerOverlay.locator(".thread").filter({
      hasText: "pinned feedback",
    });
    const pinnedThreadId = await developerPinnedThread.getAttribute("data-review-thread-id");
    expect(pinnedThreadId).not.toBeNull();
    page.once("dialog", (dialog) => dialog.accept());
    await developerPinnedThread.getByRole("button", { name: "Delete comment" }).click();
    await expect(developerOverlay.locator(
      `.thread[data-review-thread-id="${pinnedThreadId}"]`,
    )).toContainText("Deleted comment");
    await expect(developerOverlay.locator(".marker")).toHaveCount(2);

    await page.evaluate(() => history.pushState({}, "", "/products"));
    await expect(developerOverlay.getByRole("status")).toHaveText("No comments on this page");
    await expect(developerOverlay.locator(".marker")).toHaveCount(0);
    await developerOverlay.getByRole("textbox", { name: "Comment", exact: true }).fill("products feedback");
    await developerOverlay.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(developerOverlay.locator(".comment")).toContainText("products feedback");

    await page.evaluate(() => history.replaceState({}, "", "/catalog"));
    await expect(developerOverlay.getByRole("status")).toHaveText("No comments on this page");
    await page.evaluate(() => history.pushState({}, "", "/products"));
    await expect(developerOverlay.locator(".comment")).toContainText("products feedback");
    await page.goBack();
    await expect(developerOverlay.getByRole("status")).toHaveText("No comments on this page");
    await page.goBack();
    await expect(developerOverlay.locator(".comment").filter({ hasText: "home feedback" })).toHaveCount(1);
    await expect(developerOverlay.locator(".comment").filter({ hasText: "products feedback" })).toHaveCount(0);
    await expect(developerOverlay.locator(".marker")).toHaveCount(2);

    runtime.failCommentReads();
    await page.evaluate(() => history.pushState({}, "", "/unavailable"));
    await expect(developerOverlay.getByRole("status")).toContainText("Review unavailable:");
    await expect(page.getByRole("heading", { name: "Review fixture app" })).toBeVisible();
    expect(runtime.gatewayEvents.some((event) =>
      event.event === "review.content_failed" && event.reason === "unavailable"
    )).toBe(true);
    expect(runtime.localPaths).not.toContain("/_review-tunnel/review/bootstrap.js");
    expect(runtime.localPaths).not.toContain("/_review-tunnel/review/context");
    expect(runtime.localPaths).not.toContain("/_review-tunnel/review/comments");
  } finally {
    await page.close();
    await runtime.close();
  }
});

async function startReviewRuntime() {
  const authService = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: new TestHasher(),
    sessionHmacKey: Buffer.alloc(32, 5),
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

  const localPaths = [];
  const origin = createServer((incoming, response) => {
    localPaths.push(new URL(incoming.url ?? "/", "http://origin.invalid").pathname);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'nonce-review-tunnel-test'; style-src 'nonce-review-tunnel-test'; connect-src 'self'; object-src 'none'; base-uri 'none'",
    );
    response.end(`<!doctype html>
      <html><body>
        <h1>Review fixture app</h1>
        <script type="module" nonce="review-tunnel-test" src="/_review-tunnel/review/bootstrap.js"></script>
      </body></html>`);
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originAddress = origin.address();
  if (originAddress === null || typeof originAddress === "string") {
    throw new Error("review origin did not bind");
  }

  const repository = new InMemoryReviewRepository();
  const service = createReviewService({ repository });
  let conflictNextStatusChange = false;
  let conflictNextContentMutation = false;
  const changePageCommentStatus = repository.changePageCommentStatus.bind(repository);
  repository.changePageCommentStatus = async (input) => {
    if (conflictNextStatusChange) {
      conflictNextStatusChange = false;
      return { status: "STATE_CONFLICT" };
    }
    return changePageCommentStatus(input);
  };
  const updateComment = repository.updateComment.bind(repository);
  repository.updateComment = async (input) => {
    if (conflictNextContentMutation) {
      conflictNextContentMutation = false;
      return { status: "VERSION_CONFLICT" };
    }
    return updateComment(input);
  };
  const gatewayEvents = [];
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    contentDomain: "localhost",
    controlHost: "control.localhost",
    authService,
    reviewService: service,
    secureCookies: false,
    logger(event) {
      gatewayEvents.push(event);
    },
  });
  const gatewayPort = await gateway.listen();
  const tunnelId = `review-overlay-${process.pid}`;
  const credential = await authService.issueCarrierCredential(developer.principal, {
    purpose: "create",
    tunnelId,
  });
  const client = connectTunnelClient({
    gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
    localOrigin: `http://127.0.0.1:${originAddress.port}`,
    carrierCredential: credential,
  });
  const active = await client.ready;
  const binding = await sendControl(gatewayPort, tunnelId, developer.sessionToken);
  if (binding.status !== 200) throw new Error(`review binding failed: ${binding.status}`);
  const authority = new URL(active.shareUrl).host;
  const intent = await authService.createLoginIntent(authority, "/");
  const exchange = await authService.createSessionExchange(reviewer.principal, intent);
  const content = await authService.consumeSessionExchange(exchange.code, authority);
  const developerIntent = await authService.createLoginIntent(authority, "/");
  const developerExchange = await authService.createSessionExchange(
    developer.principal,
    developerIntent,
  );
  const developerContent = await authService.consumeSessionExchange(
    developerExchange.code,
    authority,
  );

  return {
    shareUrl: active.shareUrl,
    contentSessionToken: content.sessionToken,
    developerContentSessionToken: developerContent.sessionToken,
    localPaths,
    gatewayEvents,
    conflictNextStatusChange() {
      conflictNextStatusChange = true;
    },
    conflictNextContentMutation() {
      conflictNextContentMutation = true;
    },
    failCommentReads() {
      repository.listPageCommentPage = async () => {
        throw new Error("simulated review storage failure");
      };
    },
    async close() {
      await client.close().catch(() => undefined);
      await gateway.close();
      origin.close();
      await once(origin, "close");
    },
  };
}

function sendControl(port, tunnelId, sessionToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      projectSlug: "storefront",
      revisionKey: "commit-a",
    }).toString();
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: `/api/client/review-bindings/${tunnelId}`,
      method: "PUT",
      headers: {
        host: "control.localhost",
        accept: "application/json",
        authorization: `Bearer ${sessionToken}`,
        "x-review-tunnel-client": "1",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
