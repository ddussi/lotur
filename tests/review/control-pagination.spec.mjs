import { expect, test } from "@playwright/test";
import { REVIEW_CONTROL_HTML, REVIEW_CONTROL_SOURCE } from "../../apps/gateway/src/review-control-view.ts";

const result = (body, cursor = null) => ({
  comments: [{ id: body, body, routePath: "/", author: { displayName: "Reviewer" }, status: "OPEN" }],
  pageInfo: { hasMore: Boolean(cursor), nextCursor: cursor }, openCount: 1, filteredCount: 1,
});

async function openProject(page) {
  const pending = [];
  await page.route("https://control.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/comments")) {
      pending.push({ url, respond: (body, status = 200) => route.fulfill({ status, json: body }) });
      return;
    }
    if (url.pathname === "/reviews/app.js") return route.fulfill({ contentType: "text/javascript", body: REVIEW_CONTROL_SOURCE });
    if (url.pathname === "/api/reviews/notifications") return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (url.pathname === "/api/reviews/projects/project") return route.fulfill({ json: { revisions: [{ id: "v1", key: "first", openCount: 1 }, { id: "v2", key: "second", openCount: 1 }] } });
    return route.fulfill({ contentType: "text/html", body: REVIEW_CONTROL_HTML });
  });
  await page.goto("https://control.test/reviews/projects/project");
  const next = async () => {
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    return pending.shift();
  };
  await (await next()).respond(result("initial", "old-cursor"));
  await expect(page.locator("#main li")).toHaveText(/initial/);
  return { pending, next, more: page.getByRole("button", { name: "이전 댓글 더 보기", includeHidden: true }), rows: page.locator("#main li") };
}

for (const filter of ["status", "revision", "author", "path"]) {
  test(`project ${filter} filter invalidates cursor while first page is pending`, async ({ page }) => {
    const ui = await openProject(page);
    if (filter === "status") await page.getByLabel("상태", { exact: true }).selectOption("ALL");
    if (filter === "revision") await page.getByLabel("버전", { exact: true }).selectOption("v2");
    if (filter === "author") await page.getByLabel("내가 시작한 리뷰").check();
    if (filter === "path") { await page.getByLabel("페이지 경로 (선택)").fill("/new"); await page.getByLabel("페이지 경로 (선택)").press("Tab"); }
    const first = await ui.next();
    expect(first.url.searchParams.has("before")).toBe(false);
    await expect(ui.more).toBeDisabled();
    await ui.more.evaluate(button => { button.click(); button.dispatchEvent(new MouseEvent("click")); });
    expect(ui.pending).toHaveLength(0);
    await first.respond(result("filtered", "new-cursor"));
    await expect(ui.rows).toHaveText(/filtered/);
    await ui.more.click();
    const older = await ui.next();
    expect(older.url.searchParams.get("before")).toBe("new-cursor");
    await older.respond(result("older"));
    await expect(ui.rows).toHaveCount(2);
  });
}

for (const staleFailure of [false, true]) {
  test(`project ignores stale More ${staleFailure ? "error" : "success"} after filter change`, async ({ page }) => {
    const ui = await openProject(page);
    await ui.more.click();
    const stale = await ui.next();
    await page.getByLabel("상태", { exact: true }).selectOption("ALL");
    const latest = await ui.next();
    await latest.respond(result("latest", "latest-cursor"));
    await expect(ui.rows).toHaveText(/latest/);
    const completed = page.waitForResponse(response => response.url() === stale.url.href);
    await stale.respond(staleFailure ? { error: "STALE_ERROR" } : result("stale"), staleFailure ? 500 : 200);
    await (await completed).finished();
    await expect(ui.rows).toHaveText(/latest/);
    await expect(page.locator("#status")).toHaveText("미해결 1개 · 현재 조건 1개");
    await expect(ui.more).toBeEnabled();
    await ui.more.click();
    const older = await ui.next();
    expect(older.url.searchParams.get("before")).toBe("latest-cursor");
    await older.respond(result("latest older"));
  });
}

test("project More serializes duplicate clicks and permits retry after failure", async ({ page }) => {
  const ui = await openProject(page);
  await ui.more.evaluate(button => { button.click(); button.click(); button.dispatchEvent(new MouseEvent("click")); });
  const older = await ui.next();
  await expect(ui.more).toBeDisabled();
  expect(ui.pending).toHaveLength(0);
  await older.respond({ error: "TRY_AGAIN" }, 500);
  await expect(page.locator("#status")).toHaveText("TRY_AGAIN");
  await expect(ui.more).toBeEnabled();
  await ui.more.click();
  const retry = await ui.next();
  expect(retry.url.searchParams.get("before")).toBe("old-cursor");
  await retry.respond(result("retried"));
  await expect(ui.rows).toHaveCount(2);
  await expect(ui.more).toBeHidden();
});

for (const staleFailure of [false, true]) {
  test(`project stale first page ${staleFailure ? "error" : "success"} cannot unlock a newer pending filter`, async ({ page }) => {
    const ui = await openProject(page);
    await page.getByLabel("상태", { exact: true }).selectOption("ALL");
    const stale = await ui.next();
    await page.getByLabel("버전", { exact: true }).selectOption("v2");
    const latest = await ui.next();
    const completed = page.waitForResponse(response => response.url() === stale.url.href);
    await stale.respond(staleFailure ? { error: "STALE_FIRST_PAGE" } : result("stale first", "stale-cursor"), staleFailure ? 500 : 200);
    await (await completed).finished();
    await expect(ui.more).toBeDisabled();
    await expect(ui.more).toBeHidden();
    await expect(page.locator("#status")).not.toContainText("STALE_FIRST_PAGE");
    await latest.respond(result("final filter"));
    await expect(ui.rows).toHaveText(/final filter/);
  });
}

test("project failed first page never retains rows from the previous filter", async ({ page }) => {
  const ui = await openProject(page);
  await page.getByLabel("상태", { exact: true }).selectOption("ALL");
  const latest = await ui.next();
  await expect(ui.rows).toHaveCount(0);
  await expect(page.locator("#status")).toHaveText("불러오는 중…");
  await latest.respond({ error: "CURRENT_FILTER_FAILED" }, 500);
  await expect(page.locator("#status")).toHaveText("CURRENT_FILTER_FAILED");
  await expect(ui.rows).toHaveCount(0);
  await expect(ui.more).toBeHidden();
  await ui.more.evaluate(button => button.dispatchEvent(new MouseEvent("click")));
  expect(ui.pending).toHaveLength(0);
});
