import assert from "node:assert/strict";
import test from "node:test";
import { createDraftStore } from "./review-ui/drafts.ts";
import { refreshLoadedPage } from "./review-ui/page-state.ts";
import type { CommentPage, PublicComment } from "./review-ui/contracts.ts";

test("reply drafts are scoped to routes and survive failed or superseded submissions", () => {
  const drafts = createDraftStore();
  drafts.write("/one", "thread", "first draft");
  const submitted = drafts.capture("/one", "thread");
  drafts.write("/two", "thread", "another route");
  assert.equal(drafts.read("/one", "thread"), "first draft");
  drafts.write("/one", "thread", "new writing while the request is pending");
  assert.equal(drafts.acknowledge(submitted), false);
  assert.equal(drafts.read("/one", "thread"), "new writing while the request is pending");
  assert.equal(drafts.acknowledge(drafts.capture("/one", "thread")), true);
  assert.equal(drafts.read("/one", "thread"), "");
  assert.equal(drafts.read("/two", "thread"), "another route");
});

test("refresh revalidates every loaded comment and reply range instead of retaining stale records", async () => {
  const old = comment("old");
  const latest = comment("latest");
  const olderReply = { id: "old-reply", threadId: old.id, body: "old reply" } as PublicComment["replies"][number];
  const newReply = { id: "new-reply", threadId: old.id, body: "new reply" } as PublicComment["replies"][number];
  const current: CommentPage = { comments: [{ ...old, replies: [olderReply, newReply] }, latest], openCount: 2, eventCursor: "1", pageInfo: { hasMore: false } };
  const reads: string[] = [];
  const refreshed = await refreshLoadedPage({
    async page(_path, before) {
      reads.push(before ?? "latest");
      return before === undefined
        ? { comments: [latest], openCount: 1, eventCursor: "3", pageInfo: { hasMore: true, nextCursor: "older" } }
        : { comments: [{ ...old, body: null, version: 2, replies: [newReply], replyPageInfo: { hasMore: true, nextCursor: "older-reply" } }], openCount: 1, eventCursor: "3", pageInfo: { hasMore: false } };
    },
    async replies(_id, _path, before) {
      reads.push(before ?? "replies");
      return { replies: [{ ...olderReply, body: "edited old reply" }], pageInfo: { hasMore: false } };
    },
  }, "/", current);
  assert.deepEqual(reads, ["latest", "older", "older-reply"]);
  assert.equal(refreshed.comments[0]?.body, null);
  assert.equal(refreshed.comments[0]?.version, 2);
  assert.equal(refreshed.comments[0]?.replies[0]?.body, "edited old reply");
  assert.equal(refreshed.pageInfo.hasMore, false);
  assert.equal(refreshed.eventCursor, "3");
});

function comment(id: string): PublicComment {
  return { id, body: id, version: 1, replies: [], replyPageInfo: { hasMore: false } } as unknown as PublicComment;
}
