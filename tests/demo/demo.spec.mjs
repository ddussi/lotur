import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixture, login } from "./runtime.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const execute = promisify(execFile);

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
