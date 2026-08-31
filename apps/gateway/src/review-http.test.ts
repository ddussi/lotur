import assert from "node:assert/strict";
import { test } from "node:test";

import type { Principal } from "../../../packages/auth/src/index.ts";
import {
  REVIEW_BOOTSTRAP_SOURCE,
  REVIEW_PAGE_MERGER_SOURCE,
  REVIEW_REFRESH_COORDINATOR_SOURCE,
} from "./review-bootstrap.ts";
import { createReviewEventAdmission, reviewActorFromPrincipal } from "./review-http.ts";

test("review SSE admission counts pending opens and releases each slot once", () => {
  const admission = createReviewEventAdmission({
    maxConnections: 2,
    maxConnectionsPerAccount: 1,
  });
  const releaseOne = admission.tryAcquire("account-one");
  assert.notEqual(releaseOne, undefined);
  assert.equal(admission.tryAcquire("account-one"), undefined);
  const releaseTwo = admission.tryAcquire("account-two");
  assert.notEqual(releaseTwo, undefined);
  assert.equal(admission.tryAcquire("account-three"), undefined);

  releaseOne?.();
  releaseOne?.();
  const releaseThree = admission.tryAcquire("account-three");
  assert.notEqual(releaseThree, undefined);
  assert.equal(admission.tryAcquire("account-one"), undefined);

  releaseTwo?.();
  releaseThree?.();
  assert.notEqual(admission.tryAcquire("account-one"), undefined);
});

test("review capabilities are explicitly derived from authenticated account roles", () => {
  const base: Principal = {
    accountId: "account-one",
    authVersion: 7,
    username: "account-one",
    displayName: "Account One",
    roles: ["REVIEWER"],
    mustChangePassword: false,
    sessionId: "session-one",
  };
  assert.deepEqual(reviewActorFromPrincipal(base), {
    accountId: "account-one",
    username: "account-one",
    authorizationVersion: 7,
    displayName: "Account One",
    capabilities: {
      canRead: true,
      canComment: true,
      canManageProject: false,
    },
  });
  assert.deepEqual(reviewActorFromPrincipal({ ...base, roles: ["DEVELOPER"] }).capabilities, {
    canRead: true,
    canComment: true,
    canManageProject: true,
  });
  assert.deepEqual(reviewActorFromPrincipal({ ...base, roles: ["ADMIN"] }).capabilities, {
    canRead: false,
    canComment: false,
    canManageProject: false,
  });
});

test("review bootstrap isolates UI, follows SPA paths, and renders comments as text", () => {
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /history\[name\]/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /"pushState"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /"replaceState"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /"popstate"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /text\.textContent = item\.body/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /replyBody\.textContent = itemReply\.body/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Reply to comment/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /expectedStatus: item\.status/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /, "PATCH", \{/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Select area or pin/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /selection: "POINT"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /selection: "RECT"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /item\.anchor\.type === "REGION_V1"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /markerLabel\.textContent = String\(item\.pinNumber\)/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /"Pin #" \+ item\.pinNumber/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /window\.addEventListener\("scroll"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /event\.key === "Escape"/);
  assert.match(
    REVIEW_BOOTSTRAP_SOURCE,
    /new EventSource\([\s\S]*api \+ "\/events\?path="[\s\S]*"&after=" \+ encodeURIComponent\(eventCursor\)/,
  );
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /addEventListener\("review"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /if \(refreshPromise !== undefined\)/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /refreshDirty = true/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /while \(refreshDirty\)/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /routePath === location\.pathname/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Load older comments/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Load older replies/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /addEventListener\("review-error"/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /expectedVersion: item\.version/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /, "DELETE", \{/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Deleted comment/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Deleted reply/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /window\.confirm\("Delete this comment\?/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /\/notifications\?path=/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Mark read/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /mention participants with @username/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /const readReview =/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /const mutateReview =/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /const setPassiveStatus =/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /style\.nonce = bootstrapScript\.nonce/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /createElementNS\(svgNamespace, "svg"\)/);
  assert.doesNotMatch(REVIEW_BOOTSTRAP_SOURCE, /\.style\./);
  assert.doesNotMatch(REVIEW_BOOTSTRAP_SOURCE, /latestItems|latestOpenCount|commentPageInfo/);
  assert.doesNotMatch(REVIEW_BOOTSTRAP_SOURCE, /\.innerHTML\s*=/);
  assert.match(REVIEW_BOOTSTRAP_SOURCE, /Review unavailable:/);
});

test("review refresh bursts use one in-flight load and one dirty follow-up", async () => {
  const createCoordinator = Function(`return (${REVIEW_REFRESH_COORDINATOR_SOURCE})`)() as (
    load: () => Promise<void>,
  ) => () => Promise<void>;
  const releases: Array<() => void> = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const requestLoad = createCoordinator(() => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve) => releases.push(() => {
      active -= 1;
      resolve();
    }));
  });

  const burst = Array.from({ length: 20 }, () => requestLoad());
  assert.equal(calls, 1);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  releases.shift()?.();
  await Promise.all(burst);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test("review refresh keeps pages of older comments and replies already loaded", () => {
  const mergePages = Function(`return (${REVIEW_PAGE_MERGER_SOURCE})`)() as (
    current: unknown,
    latest: unknown,
  ) => {
    comments: Array<{
      id: string;
      body?: string;
      replies: Array<{ id: string; body?: string }>;
      replyPageInfo: { hasMore: boolean; nextCursor?: string };
    }>;
    openCount: number;
    eventCursor: string;
    pageInfo: { hasMore: boolean; nextCursor?: string };
  };
  const current = {
    comments: [
      { id: "old-comment", replies: [], replyPageInfo: { hasMore: false } },
      {
        id: "new-comment",
        body: "before",
        replies: [{ id: "old-reply" }, { id: "new-reply", body: "before" }],
        replyPageInfo: { hasMore: false },
      },
    ],
    openCount: 2,
    eventCursor: "8",
    pageInfo: { hasMore: false },
  };
  const latest = {
    comments: [{
      id: "new-comment",
      body: "after",
      replies: [{ id: "new-reply", body: "after" }],
      replyPageInfo: { hasMore: true, nextCursor: "reply-cursor" },
    }],
    openCount: 1,
    eventCursor: "9",
    pageInfo: { hasMore: true, nextCursor: "comment-cursor" },
  };

  const merged = mergePages(current, latest);
  assert.deepEqual(merged.comments.map((comment: { id: string }) => comment.id), [
    "old-comment",
    "new-comment",
  ]);
  const mergedNewComment = merged.comments[1];
  assert.ok(mergedNewComment);
  assert.equal(mergedNewComment.body, "after");
  assert.deepEqual(
    mergedNewComment.replies.map((reply: { id: string }) => reply.id),
    ["old-reply", "new-reply"],
  );
  const mergedNewReply = mergedNewComment.replies[1];
  assert.ok(mergedNewReply);
  assert.equal(mergedNewReply.body, "after");
  assert.deepEqual(mergedNewComment.replyPageInfo, { hasMore: false });
  assert.deepEqual(merged.pageInfo, { hasMore: false });
  assert.equal(merged.openCount, 1);
  assert.equal(merged.eventCursor, "9");
});
