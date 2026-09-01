import assert from "node:assert/strict";
import test from "node:test";
import { checkContentMutation, type ContentMutationCheck } from "./content-mutation-policy.ts";

test("content mutation policy keeps ownership, state and version conflict precedence", () => {
  const base: ContentMutationCheck = {
    action: "UPDATE", actorAccountId: "author", canManageProject: false,
    content: { authorAccountId: "author", version: 2, deleted: false },
    thread: { status: "OPEN", deleted: false }, expectedVersion: 2,
  };
  assert.equal(checkContentMutation(base), "ALLOWED");
  assert.equal(checkContentMutation({ ...base, actorAccountId: "other", canManageProject: true }), "FORBIDDEN");
  assert.equal(checkContentMutation({ ...base, thread: { status: "RESOLVED", deleted: false } }), "STATE_CONFLICT");
  assert.equal(checkContentMutation({ ...base, thread: { status: "OPEN", deleted: true } }), "STATE_CONFLICT");
  assert.equal(checkContentMutation({ ...base, expectedVersion: 1 }), "VERSION_CONFLICT");
  const deleted = { ...base, content: { ...base.content, deleted: true }, expectedVersion: 1 };
  assert.equal(checkContentMutation(deleted), "STATE_CONFLICT");
  assert.equal(checkContentMutation({ ...deleted, actorAccountId: "other" }), "FORBIDDEN");
  assert.equal(checkContentMutation({ ...base, action: "DELETE", actorAccountId: "other" }), "FORBIDDEN");
  assert.equal(checkContentMutation({ ...base, action: "DELETE", actorAccountId: "other", canManageProject: true }), "ALLOWED");
  assert.equal(checkContentMutation({ ...base, action: "DELETE", thread: { status: "RESOLVED", deleted: true } }), "ALLOWED");
  assert.equal(checkContentMutation({ ...deleted, action: "DELETE" }), "STATE_CONFLICT");
});
