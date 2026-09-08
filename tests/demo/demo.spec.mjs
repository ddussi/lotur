import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";

const root = fileURLToPath(new URL("../..", import.meta.url));
const execute = promisify(execFile);
async function ports() {
  const reservations = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const server = createServer();
      server.listen(0, "127.0.0.1"); await once(server, "listening"); reservations.push(server);
    }
    return reservations.map(server => server.address().port);
  } finally { await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve)))); }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-demo-browser-"));
  const [databasePort, gatewayPort, appPort] = await ports();
  const args = ["scripts/demo.mjs", "--state-dir", directory, "--database-port", String(databasePort), "--gateway-port", String(gatewayPort), "--app-port", String(appPort)];
  let current;
  async function stop(signal = "SIGTERM") {
    if (!current || current.child.exitCode !== null || current.child.signalCode !== null) return;
    current.child.kill(signal);
    let timer;
    try { await Promise.race([current.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Demo did not stop")), 30_000); })]); }
    finally { clearTimeout(timer); }
  }
  async function start({ waitUntilReady = true } = {}) {
    let output = "";
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    current = { child, closed: once(child, "exit"), output: () => output };
    if (!waitUntilReady) return current;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Demo exited: ${output}`);
      try {
        const ready = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
        const accounts = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"));
        return { ...ready, accounts };
      } catch {}
      await delay(100);
    }
    throw new Error(`Demo did not become ready: ${output}`);
  }
  async function inspectDatabase() {
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    const pool = new Pool({ connectionString: `postgres://demo_runtime:${config.runtimePassword}@127.0.0.1:${databasePort}/review_tunnel_demo` });
    try {
      return {
        threads: (await pool.query("SELECT id, body, status, workflow_version, anchor FROM rt_review_threads ORDER BY id")).rows,
        replies: (await pool.query("SELECT id, thread_id, body FROM rt_review_replies ORDER BY id")).rows,
        notifications: (await pool.query("SELECT id, recipient_account_id, reason FROM rt_review_notifications ORDER BY id")).rows,
      };
    } finally { await pool.end(); }
  }
  async function close() {
    try { await stop(); }
    finally {
      const reset = await execute(process.execPath, ["scripts/demo.mjs", "reset", "--state-dir", directory, "--confirm-delete-demo-data"], { cwd: root });
      assert.match(reset.stdout, /deleted/);
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { directory, args, start, stop, inspectDatabase, close, current: () => current };
}
async function login(page, url, account) {
  await page.goto(url);
  if (new URL(page.url()).pathname === "/login") {
    await page.getByLabel("아이디", { exact: true }).fill(account.username);
    await page.getByLabel("비밀번호", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
  }
}

test("one-command demo supports two actors, stable pins, notifications and persisted re-review across restart", async ({ browser }, testInfo) => {
  const demo = await fixture();
  const reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const developerContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const reviewer = await reviewerContext.newPage();
  const developer = await developerContext.newPage();
  const pageErrors = [];
  reviewer.on("pageerror", error => pageErrors.push(error.message));
  developer.on("pageerror", error => pageErrors.push(error.message));
  try {
    const started = Date.now();
    const ready = await demo.start();
    const duplicate = await execute(process.execPath, demo.args, { cwd: root }).then(() => undefined, error => error);
    expect(duplicate?.code).toBe(1);
    expect(duplicate.stderr).toContain("already using");
    await login(reviewer, ready.shareUrl, ready.accounts.reviewer);
    await expect(reviewer.getByRole("heading", { name: "A calmer way to launch." })).toBeVisible();
    const overlay = reviewer.locator("review-tunnel-overlay");
    const card = reviewer.locator('[data-review-id="launch-card"]');
    const box = await card.boundingBox();
    await overlay.getByRole("button", { name: "Select area or pin" }).click();
    await reviewer.mouse.move(box.x + box.width * .15, box.y + box.height * .1);
    await reviewer.mouse.down();
    await reviewer.mouse.move(box.x + box.width * .65, box.y + box.height * .35, { steps: 4 });
    await reviewer.mouse.up();
    const comment = "@developer Please check the launch card spacing.";
    await overlay.getByRole("textbox", { name: "Comment", exact: true }).fill(comment);
    await overlay.getByRole("button", { name: "Comment", exact: true }).click();
    const thread = overlay.locator(".thread").filter({ hasText: comment });
    await expect(thread).toBeVisible();
    const firstFeedbackMs = Date.now() - started;
    const permalink = await thread.getByRole("link", { name: "Permanent link" }).getAttribute("href");
    expect(new URL(permalink).origin).toBe(ready.controlUrl);
    await overlay.getByRole("button", { name: "Close review panel" }).click();
    await reviewer.getByRole("button", { name: "Try compact layout" }).click();
    await expect.poll(() => reviewer.evaluate(() => {
      const target = document.querySelector('[data-review-id="launch-card"]').getBoundingClientRect();
      const marker = document.querySelector("review-tunnel-overlay").shadowRoot.querySelector(".marker.rect .marker-shape");
      if (!marker) return Infinity;
      return Math.max(Math.abs(Number(marker.getAttribute("x")) - (target.x + target.width * .15)),
        Math.abs(Number(marker.getAttribute("y")) - (target.y + target.height * .1)),
        Math.abs(Number(marker.getAttribute("width")) - target.width * .5));
    })).toBeLessThan(2);
    await overlay.getByRole("button", { name: "Open review panel" }).click();
    const draft = overlay.getByRole("textbox", { name: "Comment", exact: true });
    await draft.fill("Keep this unsent draft during peer updates.");
    await overlay.getByRole("combobox", { name: "Comment status" }).selectOption("RESOLVED");
    await overlay.getByRole("combobox", { name: "Comment status" }).selectOption("OPEN");
    await expect(draft).toHaveValue("Keep this unsent draft during peer updates.");
    await login(developer, permalink, ready.accounts.developer);
    await developer.locator("#inbox summary").click();
    await expect(developer.locator("#notifications")).toContainText("Demo reviewer");
    await developer.getByRole("textbox", { name: "Reply to comment" }).fill("Updated the spacing. Please take another look.");
    let releaseReply;
    const replyGate = new Promise(resolve => { releaseReply = resolve; });
    const replyEndpoint = "**/api/reviews/comments/*/replies";
    await developer.route(replyEndpoint, async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      await replyGate;
      await route.fulfill({ response });
    });
    try {
      await developer.getByRole("button", { name: "Reply", exact: true }).click();
      // The real database event refreshes the thread while its save response is delayed.
      await expect(developer.locator(".reply")).toContainText("Updated the spacing");
      await expect(developer.getByRole("button", { name: "Request review", exact: true })).toBeDisabled();
      await expect(developer.getByRole("button", { name: "Resolve", exact: true })).toBeDisabled();
      await expect(developer.getByRole("textbox", { name: "Reply to comment" })).toBeEditable();
    } finally { releaseReply(); }
    await developer.getByRole("button", { name: "Request review", exact: true }).click();
    await developer.unroute(replyEndpoint);
    await expect(developer.locator(".thread-status")).toHaveText("Needs review");
    await expect(thread.locator(".reply")).toContainText("Updated the spacing");
    await expect(thread.locator(".thread-status")).toHaveText("Needs review");
    await expect(draft).toHaveValue("Keep this unsent draft during peer updates.");
    await reviewer.screenshot({ path: testInfo.outputPath("demo-pinned-review.png"), fullPage: true });
    await reviewer.goto(permalink);
    await reviewer.locator("#inbox summary").click();
    await expect(reviewer.locator("#notifications")).toContainText("답글을 남겼습니다");
    await reviewer.getByRole("button", { name: "Request more changes", exact: true }).click();
    await expect(reviewer.locator(".thread-status")).toHaveText("Open");
    await expect(developer.locator(".thread-status")).toHaveText("Open");
    await developer.getByRole("button", { name: "Request review", exact: true }).click();
    await expect(reviewer.getByRole("button", { name: "Confirm resolved", exact: true })).toBeVisible();
    await reviewer.getByRole("button", { name: "Confirm resolved", exact: true }).click();
    await expect(reviewer.locator(".thread-status")).toHaveText("Resolved");
    await reviewer.locator(".history summary").click();
    await expect(reviewer.locator(".history")).toContainText("NEEDS_REVIEW → RESOLVED");
    await expect(developer.locator(".thread-status")).toHaveText("Resolved");
    await reviewer.screenshot({ path: testInfo.outputPath("demo-review-inbox.png"), fullPage: true });
    const before = await demo.inspectDatabase();
    expect(before.threads).toHaveLength(1);
    expect(before.threads[0].status).toBe("RESOLVED");
    expect(before.replies).toHaveLength(1);
    expect(new Set(before.notifications.map(item => item.reason))).toEqual(new Set(["MENTION", "REPLY", "WORKFLOW_REQUEST", "WORKFLOW_RESULT"]));
    await demo.stop();
    expect((await demo.current().closed)[0]).toBe(0);
    await expect(readFile(join(demo.directory, "ready.json"))).rejects.toThrow();
    const next = await demo.start();
    expect(next.shareUrl).not.toBe(ready.shareUrl);
    expect(next.accounts).toEqual(ready.accounts);
    expect(await demo.inspectDatabase()).toEqual(before);
    await reviewer.goto(permalink);
    await expect(reviewer.locator(".thread")).toContainText(comment);
    await expect(reviewer.locator(".reply")).toContainText("Updated the spacing");
    const mobile = await reviewerContext.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await login(mobile, next.shareUrl, ready.accounts.reviewer);
    await expect(mobile.getByRole("heading", { name: "A calmer way to launch." })).toBeVisible();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mobile.screenshot({ path: testInfo.outputPath("demo-mobile.png"), fullPage: true });
    await mobile.close();
    await writeFile(testInfo.outputPath("demo-validation.json"), JSON.stringify({ firstFeedbackMs, restartPreservedDatabase: true, twoActorWorkflow: true, pinTrackedLayout: true }, null, 2));
    expect(pageErrors).toEqual([]);
  } finally {
    await reviewerContext.close(); await developerContext.close(); await demo.close();
  }
});

test("interrupted account setup resumes without resetting the database or changing configured credentials", async () => {
  const demo = await fixture();
  try {
    const process = await demo.start({ waitUntilReady: false });
    let initial;
    await expect.poll(async () => {
      try {
        initial = JSON.parse(await readFile(join(demo.directory, "config.json"), "utf8"));
        return Object.keys(initial.pendingPasswords ?? {}).length;
      } catch { return 0; }
    }, { timeout: 60_000, intervals: [5, 10, 20] }).toBeGreaterThan(0);
    await demo.stop("SIGKILL");
    expect((await process.closed)[1]).toBe("SIGKILL");
    const restarted = await demo.start();
    const final = JSON.parse(await readFile(join(demo.directory, "config.json"), "utf8"));
    expect(final.id).toBe(initial.id);
    expect(final.passwords).toEqual(initial.passwords);
    expect(final.pendingPasswords).toEqual({});
    expect(restarted.accounts.reviewer.password).toBe(initial.passwords.reviewer);
  } finally { await demo.close(); }
});
