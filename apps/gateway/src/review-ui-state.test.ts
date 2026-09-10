import assert from "node:assert/strict";
import test from "node:test";
import { createDraftStore } from "./review-ui/drafts.ts";
import { refreshLoadedPage } from "./review-ui/page-state.ts";
import type { CommentPage, PublicComment } from "./review-ui/contracts.ts";

function draftStorage() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const draftScope = (session = "session-one", revision = "revision-one") => JSON.stringify([session, "account", "project", revision]);

test("drafts restore text and anchor data after reload, isolate revisions and expire", () => {
  const storage = draftStorage();
  let now = 100;
  const original = createDraftStore({ storage, now: () => now });
  original.setScope(draftScope());
  original.write("/one", "", "page draft", { anchor: "saved area" });
  original.dispose();
  const restored = createDraftStore({ storage, now: () => now });
  restored.setScope(draftScope());
  assert.equal(restored.read("/one", ""), "page draft");
  assert.deepEqual(restored.get("/one", "")?.data, { anchor: "saved area" });
  assert.equal(restored.read("/other", ""), "");
  const submitted = restored.capture("/one", "");
  restored.setScope(draftScope("session-one", "revision-two"));
  restored.write("/one", "", "other revision");
  assert.equal(restored.acknowledge(submitted), false);
  restored.setScope(draftScope());
  assert.equal(restored.read("/one", ""), "page draft");
  now += 13 * 60 * 60_000;
  const expired = createDraftStore({ storage, now: () => now });
  expired.setScope(draftScope());
  assert.equal(expired.read("/one", ""), "");
});

test("a new login purges old drafts; successful submissions and access denial remove saved copies", () => {
  const storage = draftStorage();
  const original = createDraftStore({ storage }); original.setScope(draftScope());
  original.write("/", "reply", "private draft");
  const next = createDraftStore({ storage }); next.setScope(draftScope("new-session"));
  assert.equal(next.read("/", "reply"), "");
  assert.equal(storage.length, 0);
  next.write("/", "reply", "new reply");
  next.acknowledge(next.capture("/", "reply"));
  assert.equal(storage.length, 0);
  next.write("/", "reply", "discard on denied access");
  next.clear();
  assert.equal(storage.length, 0);
});

test("corrupt or unavailable browser storage leaves an editable in-memory draft", () => {
  const storage = draftStorage();
  const store = createDraftStore({ storage }); store.setScope(draftScope()); store.write("/", "", "old");
  storage.setItem(storage.key(0)!, "{broken");
  const restored = createDraftStore({ storage }); restored.setScope(draftScope());
  assert.equal(restored.read("/", ""), "");
  storage.setItem = () => { throw new Error("quota"); };
  restored.write("/", "", "still editable");
  assert.equal(restored.read("/", ""), "still editable");
});

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

test("a submission cannot clear a newer draft that returns to the same text", () => {
  const drafts = createDraftStore();
  drafts.write("/", "thread", "same text");
  const submitted = drafts.capture("/", "thread");
  drafts.write("/", "thread", "changed while saving");
  drafts.write("/", "thread", "same text");
  assert.equal(drafts.acknowledge(submitted), false);
  assert.equal(drafts.read("/", "thread"), "same text");
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
