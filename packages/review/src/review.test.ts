import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryReviewRepository,
  ReviewError,
  createReviewService,
  canDeleteReviewContent,
  canEditReviewContent,
  extractMentionUsernames,
  normalizeAuthorizationVersion,
  normalizeCommentBody,
  normalizeContentVersion,
  normalizeProjectSlug,
  normalizeRegionAnchor,
  normalizeReplyBody,
  normalizeReviewEventCursor,
  normalizeRevisionKey,
  normalizeRoutePath,
  normalizeThreadStatusTransition,
  type ReviewActor,
} from "./index.ts";


const developer: ReviewActor = {
  accountId: "account-developer",
  username: "developer",
  authorizationVersion: 1,
  displayName: "Developer",
  capabilities: {
    canRead: true,
    canComment: true,
    canManageProject: true,
  },
};

const reviewer: ReviewActor = {
  accountId: "account-reviewer",
  username: "reviewer",
  authorizationVersion: 1,
  displayName: "Reviewer",
  capabilities: {
    canRead: true,
    canComment: true,
    canManageProject: false,
  },
};

const outsider: ReviewActor = {
  accountId: "account-outsider",
  username: "outsider",
  authorizationVersion: 1,
  displayName: "Outsider",
  capabilities: {
    canRead: false,
    canComment: false,
    canManageProject: false,
  },
};

test("review identifiers and page paths are canonical, bounded, and fail closed", () => {
  assert.equal(normalizeProjectSlug("storefront"), "storefront");
  assert.equal(normalizeRevisionKey("4A1b2c3d"), "4A1b2c3d");
  assert.equal(normalizeRoutePath("/products/%7bsku%7d"), "/products/%7Bsku%7D");
  assert.equal(normalizeRoutePath("/한글/%5c"), "/한글/%5C");
  assert.equal(normalizeCommentBody("line one\r\nline two"), "line one\nline two");
  assert.equal(normalizeReplyBody("reply one\r\nreply two"), "reply one\nreply two");
  assert.equal(normalizeAuthorizationVersion(1), 1);
  assert.equal(normalizeContentVersion(1), 1);
  assert.equal(normalizeReviewEventCursor(undefined), "0");
  assert.equal(normalizeReviewEventCursor("42"), "42");
  assert.deepEqual(normalizeThreadStatusTransition("OPEN", "RESOLVED"), {
    expectedStatus: "OPEN",
    status: "RESOLVED",
  });
  assert.deepEqual(normalizeThreadStatusTransition("RESOLVED", "OPEN"), {
    expectedStatus: "RESOLVED",
    status: "OPEN",
  });

  for (const slug of ["Storefront", "-store", "store_1", "", "a".repeat(65)]) {
    assert.throws(() => normalizeProjectSlug(slug), ReviewError);
  }
  for (const revision of ["", " dirty ", "feature branch", "a".repeat(129)]) {
    assert.throws(() => normalizeRevisionKey(revision), ReviewError);
  }
  for (const path of ["products", "//other-host/path", "/\\example.invalid/path", "/nested\\path", "/products?token=secret", "/#fragment", "/a\u0000b", `/${"x".repeat(2_048)}`]) {
    assert.throws(() => normalizeRoutePath(path), ReviewError);
  }
  for (const body of ["", " \n\t ", "bad\u0000body", "x".repeat(4_001)]) {
    assert.throws(() => normalizeCommentBody(body), ReviewError);
    assert.throws(() => normalizeReplyBody(body), ReviewError);
  }
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeAuthorizationVersion(version), ReviewError);
    assert.throws(() => normalizeContentVersion(version), ReviewError);
  }
  for (const cursor of ["", "01", "-1", "1.5", "9223372036854775808"]) {
    assert.throws(() => normalizeReviewEventCursor(cursor), ReviewError);
  }
  assert.throws(
    () => normalizeThreadStatusTransition("OPEN", "OPEN"),
    ReviewError,
  );
});

test("mentions are plain-text usernames with stable de-duplication and bounded fanout", () => {
  assert.deepEqual(
    extractMentionUsernames("Hi @Reviewer, @developer and again @reviewer"),
    ["reviewer", "developer"],
  );
  assert.deepEqual(extractMentionUsernames("mail@example.com and @ab are not mentions"), []);
  assert.throws(
    () => extractMentionUsernames(Array.from({ length: 21 }, (_, index) => `@user${index}`).join(" ")),
    (error: unknown) => error instanceof ReviewError && error.code === "INVALID_INPUT",
  );
});

test("content mutation permissions keep edits author-only and deletion explicitly manageable", () => {
  assert.equal(canEditReviewContent(reviewer, reviewer.accountId), true);
  assert.equal(canEditReviewContent(developer, reviewer.accountId), false);
  assert.equal(canDeleteReviewContent(reviewer, reviewer.accountId), true);
  assert.equal(canDeleteReviewContent(developer, reviewer.accountId), true);
  assert.equal(canDeleteReviewContent(outsider, reviewer.accountId), false);
});

test("REGION_V1 anchors canonicalize point and rectangle geometry", () => {
  assert.deepEqual(normalizeRegionAnchor({
    type: "REGION_V1",
    selection: "POINT",
    x: 0.1250004,
    y: 0.75,
    width: 0,
    height: 0,
    document: { width: 1440, height: 3200 },
    viewport: { width: 1280, height: 720 },
  }), {
    type: "REGION_V1",
    selection: "POINT",
    x: 0.125,
    y: 0.75,
    width: 0,
    height: 0,
    document: { width: 1440, height: 3200 },
    viewport: { width: 1280, height: 720 },
  });
  assert.deepEqual(normalizeRegionAnchor({
    type: "REGION_V1",
    selection: "RECT",
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
    document: { width: 1440.4, height: 3200.2 },
    viewport: { width: 1280.1, height: 720.3 },
  }), {
    type: "REGION_V1",
    selection: "RECT",
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
    document: { width: 1440.4, height: 3200.2 },
    viewport: { width: 1280.1, height: 720.3 },
  });

  for (const anchor of [
    null,
    { type: "PAGE" },
    { type: "REGION_V1", selection: "POINT", x: -0.1, y: 0.5, width: 0, height: 0, document: { width: 1, height: 1 }, viewport: { width: 1, height: 1 } },
    { type: "REGION_V1", selection: "POINT", x: 0.1, y: 0.5, width: 0.1, height: 0, document: { width: 1, height: 1 }, viewport: { width: 1, height: 1 } },
    { type: "REGION_V1", selection: "RECT", x: 0.8, y: 0.5, width: 0.3, height: 0.2, document: { width: 1, height: 1 }, viewport: { width: 1, height: 1 } },
    { type: "REGION_V1", selection: "RECT", x: 0.1, y: 0.1, width: 0, height: 0.2, document: { width: 1, height: 1 }, viewport: { width: 1, height: 1 } },
    { type: "REGION_V1", selection: "RECT", x: 0.1, y: 0.1, width: 0.2, height: 0.2, document: { width: 0, height: 1 }, viewport: { width: 1, height: 1 } },
  ]) assert.throws(() => normalizeRegionAnchor(anchor), ReviewError);
});

test("element anchors accept only bounded identities and matching relative geometry", () => {
  const anchor = {
    type: "REGION_V1", selection: "RECT", x: 0.1, y: 0.2, width: 0.2, height: 0.1,
    document: { width: 1440, height: 1600 }, viewport: { width: 1440, height: 900 },
    element: { attribute: "data-review-id", value: "checkout:primary", x: 0.1250004, y: 0.1, width: 0.5, height: 0.4 },
  };
  assert.deepEqual(normalizeRegionAnchor(anchor).element, { ...anchor.element, x: 0.125 });
  assert.equal(normalizeRegionAnchor({ ...anchor, element: { ...anchor.element, attribute: "id" } }).element?.attribute, "id");
  for (const element of [
    null, undefined, { ...anchor.element, selector: "#checkout" },
    { ...anchor.element, attribute: "onclick" }, { ...anchor.element, value: " " },
    { ...anchor.element, value: "x".repeat(257) }, { ...anchor.element, value: "bad\nidentity" },
    { ...anchor.element, x: Number.NaN }, { ...anchor.element, y: -1 },
    { ...anchor.element, width: 0 }, { ...anchor.element, x: 0.9, width: 0.2 },
  ]) assert.throws(() => normalizeRegionAnchor({ ...anchor, element }), ReviewError);
  assert.throws(() => normalizeRegionAnchor({ ...anchor, selection: "POINT", width: 0, height: 0 }), ReviewError);
  assert.equal(normalizeRegionAnchor({
    ...anchor, selection: "POINT", width: 0, height: 0,
    element: { ...anchor.element, width: 0, height: 0 },
  }).element?.width, 0);
});

test("a developer binds stable project revisions while tunnel sessions remain exact", async () => {
  const repository = new InMemoryReviewRepository();
  let id = 0;
  const service = createReviewService({
    repository,
    generateId: () => `review-id-${++id}`,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
  });

  const first = await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-one",
    sessionId: "session-one",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });
  const repeated = await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-one",
    sessionId: "session-one",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });
  const nextTunnel = await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-two",
    sessionId: "session-two",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });

  assert.equal(first.project.id, repeated.project.id);
  assert.equal(first.revision.id, repeated.revision.id);
  assert.equal(first.project.id, nextTunnel.project.id);
  assert.equal(first.revision.id, nextTunnel.revision.id);
  assert.equal(repository.projects.size, 1);
  assert.equal(repository.revisions.size, 1);
  assert.equal(repository.bindings.size, 2);

  await assert.rejects(
    service.bindTunnel({
      actor: developer,
      tunnelOwnerAccountId: developer.accountId,
      tunnelId: "tunnel-one",
      sessionId: "different-session",
      projectSlug: "storefront",
      revisionKey: "commit-a",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "CONFLICT",
  );
});

test("project binding requires the tunnel owner and project management capability", async () => {
  const service = createReviewService({ repository: new InMemoryReviewRepository() });
  const input = {
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-one",
    sessionId: "session-one",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  };

  await assert.rejects(
    service.bindTunnel({ ...input, actor: reviewer }),
    (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.bindTunnel({
      ...input,
      actor: { ...developer, accountId: "different-developer" },
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
  );
});

test("page comments are isolated by exact binding, revision, and normalized path", async () => {
  const service = createReviewService({ repository: new InMemoryReviewRepository() });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-a",
    sessionId: "session-a",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-b",
    sessionId: "session-b",
    projectSlug: "storefront",
    revisionKey: "commit-b",
  });
  const otherDeveloper: ReviewActor = {
    ...developer,
    accountId: "account-other-developer",
    displayName: "Other Developer",
  };
  await service.bindTunnel({
    actor: otherDeveloper,
    tunnelOwnerAccountId: otherDeveloper.accountId,
    tunnelId: "tunnel-c",
    sessionId: "session-c",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });

  const created = await service.createPageComment({
    actor: reviewer,
    tunnelId: "tunnel-a",
    sessionId: "session-a",
    routePath: "/products/%7bsku%7d",
    body: "<script>alert('not executable')</script>",
  });
  assert.equal(created.routePath, "/products/%7Bsku%7D");
  assert.equal(created.body, "<script>alert('not executable')</script>");
  assert.equal(created.author.displayName, "Reviewer");

  const samePath = await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-a",
    sessionId: "session-a",
    routePath: "/products/%7Bsku%7D",
  });
  const otherPath = await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-a",
    sessionId: "session-a",
    routePath: "/cart",
  });
  const otherRevision = await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-b",
    sessionId: "session-b",
    routePath: "/products/%7Bsku%7D",
  });
  const otherProject = await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-c",
    sessionId: "session-c",
    routePath: "/products/%7Bsku%7D",
  });

  assert.equal(samePath.comments[0]?.id, created.id);
  assert.deepEqual(samePath.comments[0]?.replyPageInfo, { hasMore: false });
  assert.deepEqual(otherPath.comments, []);
  assert.deepEqual(otherRevision.comments, []);
  assert.deepEqual(otherProject.comments, []);

  await assert.rejects(
    service.listPageCommentPage({
      actor: reviewer,
      tunnelId: "tunnel-a",
      sessionId: "wrong-session",
      routePath: "/products/%7Bsku%7D",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    service.createPageComment({
      actor: outsider,
      tunnelId: "tunnel-a",
      sessionId: "session-a",
      routePath: "/products/%7Bsku%7D",
      body: "hidden",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
  );
});

test("region comments share the page conversation while retaining a validated anchor", async () => {
  const service = createReviewService({ repository: new InMemoryReviewRepository() });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-region",
    sessionId: "session-region",
    projectSlug: "storefront",
    revisionKey: "commit-region",
  });
  const region = await service.createRegionComment({
    actor: reviewer,
    tunnelId: "tunnel-region",
    sessionId: "session-region",
    routePath: "/products",
    body: "Move this card",
    anchor: {
      type: "REGION_V1",
      selection: "RECT",
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      document: { width: 1440, height: 3200 },
      viewport: { width: 1280, height: 720 },
      element: { attribute: "id", value: "product-card", x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    },
  });
  const page = await service.createPageComment({
    actor: reviewer,
    tunnelId: "tunnel-region",
    sessionId: "session-region",
    routePath: "/products",
    body: "Page-wide note",
  });

  assert.equal(region.anchor.type, "REGION_V1");
  assert.deepEqual(page.anchor, { type: "PAGE" });
  const comments = (await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-region",
    sessionId: "session-region",
    routePath: "/products",
  })).comments;
  assert.deepEqual(comments.map((comment) => comment.id).sort(), [region.id, page.id].sort());
  assert.deepEqual(comments.find((comment) => comment.id === region.id)?.anchor, region.anchor);
  assert.deepEqual(comments.find((comment) => comment.id === page.id)?.anchor, page.anchor);
});

test("review context exposes only the bound project, revision, and caller capabilities", async () => {
  const service = createReviewService({ repository: new InMemoryReviewRepository() });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-a",
    sessionId: "session-a",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });

  const context = await service.getContext({
    actor: reviewer,
    tunnelId: "tunnel-a",
    sessionId: "session-a",
  });
  assert.deepEqual(context, {
    project: { id: context.project.id, slug: "storefront", displayName: "storefront" },
    revision: { id: context.revision.id, key: "commit-a" },
    features: { workflowVersion: 1, canRequestReview: true },
    principal: {
      accountId: reviewer.accountId,
      username: "reviewer",
      displayName: "Reviewer",
      canComment: true,
      canManageProject: false,
    },
  });

  await service.removeTunnelBinding({
    tunnelId: "tunnel-a",
    sessionId: "session-a",
  });
  await assert.rejects(
    service.getContext({ actor: reviewer, tunnelId: "tunnel-a", sessionId: "session-a" }),
    (error: unknown) => error instanceof ReviewError && error.code === "NOT_FOUND",
  );
});

test("review replies and thread status transitions preserve permissions and optimistic state", async () => {
  let id = 0;
  let timestamp = 0;
  const service = createReviewService({
    repository: new InMemoryReviewRepository(),
    generateId: () => `conversation-${++id}`,
    now: () => new Date(Date.UTC(2026, 7, 31, 0, 0, timestamp++)),
  });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });
  const thread = await service.createPageComment({
    actor: reviewer,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    routePath: "/products",
    body: "Please adjust the primary action",
  });

  const reply = await service.createReply({
    actor: developer,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    commentId: thread.id,
    routePath: "/products",
    body: "Updated in the next local build",
  });
  assert.equal(reply.threadId, thread.id);
  assert.equal(reply.author.displayName, "Developer");
  assert.deepEqual(
    (await service.listPageCommentPage({
      actor: reviewer,
      tunnelId: "tunnel-conversation",
      sessionId: "session-conversation",
      routePath: "/products",
    })).comments[0]?.replies,
    [reply],
  );

  await assert.rejects(
    service.changePageCommentStatus({
      actor: reviewer,
      tunnelId: "tunnel-conversation",
      sessionId: "session-conversation",
      commentId: thread.id,
      routePath: "/products",
      expectedStatus: "OPEN",
      status: "RESOLVED",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
  );
  const resolved = await service.changePageCommentStatus({
    actor: developer,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    commentId: thread.id,
    routePath: "/products",
    expectedStatus: "OPEN",
    status: "RESOLVED",
  });
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolvedBy?.accountId, developer.accountId);
  assert.ok(resolved.resolvedAt instanceof Date);

  await assert.rejects(
    service.createReply({
      actor: reviewer,
      tunnelId: "tunnel-conversation",
      sessionId: "session-conversation",
      commentId: thread.id,
      routePath: "/products",
      body: "This must wait until the thread is reopened",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "STATE_CONFLICT",
  );
  await assert.rejects(
    service.changePageCommentStatus({
      actor: developer,
      tunnelId: "tunnel-conversation",
      sessionId: "session-conversation",
      commentId: thread.id,
      routePath: "/products",
      expectedStatus: "OPEN",
      status: "RESOLVED",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "STATE_CONFLICT",
  );
  const reopened = await service.changePageCommentStatus({
    expectedWorkflowVersion: 2,
    actor: developer,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    commentId: thread.id,
    routePath: "/products",
    expectedStatus: "RESOLVED",
    status: "OPEN",
  });
  assert.equal(reopened.status, "OPEN");
  assert.equal(reopened.resolvedBy, undefined);
  assert.equal(reopened.resolvedAt, undefined);

  const events = await service.listEvents({
    actor: reviewer,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    routePath: "/products",
  });
  assert.deepEqual(events.map((event) => event.type), [
    "COMMENT_CREATED",
    "REPLY_CREATED",
    "NOTIFICATION_CREATED",
    "THREAD_STATUS_CHANGED",
    "THREAD_STATUS_CHANGED",
  ]);
  assert.deepEqual((await service.listEvents({
    actor: reviewer,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    routePath: "/products",
    afterId: events[1]!.id,
  })).map((event) => event.id), events.slice(2).map((event) => event.id));
  assert.deepEqual(await service.listEvents({
    actor: reviewer,
    tunnelId: "tunnel-conversation",
    sessionId: "session-conversation",
    routePath: "/cart",
  }), []);

  await assert.rejects(
    service.createReply({
      actor: reviewer,
      tunnelId: "tunnel-conversation",
      sessionId: "session-conversation",
      commentId: thread.id,
      routePath: "/cart",
      body: "A thread on another path must remain hidden",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "NOT_FOUND",
  );
});

test("comment and reply edits use content versions while deletion preserves tombstones", async () => {
  let id = 0;
  let timestamp = 0;
  const service = createReviewService({
    repository: new InMemoryReviewRepository(),
    generateId: () => `mutable-${++id}`,
    now: () => new Date(Date.UTC(2026, 7, 31, 1, 0, timestamp++)),
  });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });
  const thread = await service.createPageComment({
    actor: reviewer,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    routePath: "/products",
    body: "Original comment",
  });
  assert.equal(thread.version, 1);
  const reply = await service.createReply({
    actor: developer,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    commentId: thread.id,
    routePath: "/products",
    body: "Original reply",
  });
  assert.equal(reply.version, 1);

  const editedThread = await service.updateComment({
    actor: reviewer,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    commentId: thread.id,
    routePath: "/products",
    expectedVersion: 1,
    body: "Edited comment",
  });
  assert.equal(editedThread.body, "Edited comment");
  assert.equal(editedThread.version, 2);
  await assert.rejects(
    service.updateComment({
      actor: reviewer,
      tunnelId: "tunnel-mutable",
      sessionId: "session-mutable",
      commentId: thread.id,
      routePath: "/products",
      expectedVersion: 1,
      body: "Stale overwrite",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "VERSION_CONFLICT",
  );
  await assert.rejects(
    service.updateComment({
      actor: developer,
      tunnelId: "tunnel-mutable",
      sessionId: "session-mutable",
      commentId: thread.id,
      routePath: "/products",
      expectedVersion: 2,
      body: "Editing another author is forbidden",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "FORBIDDEN",
  );

  const editedReply = await service.updateReply({
    actor: developer,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    commentId: thread.id,
    replyId: reply.id,
    routePath: "/products",
    expectedVersion: 1,
    body: "Edited reply",
  });
  assert.equal(editedReply.body, "Edited reply");
  assert.equal(editedReply.version, 2);
  const deletedReply = await service.deleteReply({
    actor: developer,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    commentId: thread.id,
    replyId: reply.id,
    routePath: "/products",
    expectedVersion: 2,
  });
  assert.equal(deletedReply.body, null);
  assert.equal(deletedReply.version, 3);
  assert.equal(deletedReply.deletedBy?.accountId, developer.accountId);

  const deletedThread = await service.deleteComment({
    actor: developer,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    commentId: thread.id,
    routePath: "/products",
    expectedVersion: 2,
  });
  assert.equal(deletedThread.body, null);
  assert.equal(deletedThread.version, 3);
  assert.equal(deletedThread.deletedBy?.accountId, developer.accountId);
  assert.equal(deletedThread.replies[0]?.body, null);
  assert.equal((await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-mutable",
    sessionId: "session-mutable",
    routePath: "/products",
  })).openCount, 0);
  await assert.rejects(
    service.createReply({
      actor: reviewer,
      tunnelId: "tunnel-mutable",
      sessionId: "session-mutable",
      commentId: thread.id,
      routePath: "/products",
      body: "Deleted threads do not accept replies",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "STATE_CONFLICT",
  );
});

test("mentions notify only revision participants and keep recipient-scoped read state", async () => {
  let id = 0;
  let second = 0;
  const repository = new InMemoryReviewRepository();
  const service = createReviewService({
    repository,
    generateId: () => `mention-${++id}`,
    now: () => new Date(Date.UTC(2026, 7, 31, 2, 0, second++)),
  });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });
  const thread = await service.createPageComment({
    actor: reviewer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    routePath: "/products",
    body: "@developer please review; @outsider and @reviewer must not be notified",
  });
  const developerNotifications = await service.listNotifications({
    actor: developer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    routePath: "/products",
  });
  assert.equal(developerNotifications.length, 1);
  assert.equal(developerNotifications[0]?.actor.accountId, reviewer.accountId);
  assert.equal(developerNotifications[0]?.readAt, undefined);
  assert.deepEqual(await service.listNotifications({
    actor: reviewer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    routePath: "/products",
  }), []);

  const read = await service.setNotificationRead({
    actor: developer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    notificationId: developerNotifications[0]!.id,
    routePath: "/products",
    read: true,
  });
  assert.ok(read.readAt instanceof Date);
  assert.equal(
    (await service.listEvents({
      actor: developer,
      tunnelId: "tunnel-mentions",
      sessionId: "session-mentions",
      routePath: "/products",
    })).filter((event) => event.type === "NOTIFICATION_READ_CHANGED").length,
    1,
  );
  assert.equal(
    (await service.listEvents({
      actor: reviewer,
      tunnelId: "tunnel-mentions",
      sessionId: "session-mentions",
      routePath: "/products",
    })).filter((event) => event.type === "NOTIFICATION_READ_CHANGED").length,
    0,
  );

  const reply = await service.createReply({
    actor: developer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    commentId: thread.id,
    routePath: "/products",
    body: "@reviewer this is ready",
  });
  await service.updateReply({
    actor: developer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    commentId: thread.id,
    replyId: reply.id,
    routePath: "/products",
    expectedVersion: 1,
    body: "@reviewer this is still ready",
  });
  assert.equal((await service.listNotifications({
    actor: reviewer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    routePath: "/products",
  })).length, 1);
  const developerEvents = await service.listEvents({
    actor: developer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    routePath: "/products",
  });
  const reviewerEvents = await service.listEvents({
    actor: reviewer,
    tunnelId: "tunnel-mentions",
    sessionId: "session-mentions",
    routePath: "/products",
  });
  assert.equal(
    developerEvents.filter((event) => event.type === "NOTIFICATION_CREATED").length,
    1,
  );
  assert.equal(
    reviewerEvents.filter((event) => event.type === "NOTIFICATION_CREATED").length,
    1,
  );
});

test("comment and reply keyset pages keep the newest content visible beyond one hundred items", async () => {
  let id = 0;
  let millisecond = 0;
  const service = createReviewService({
    repository: new InMemoryReviewRepository(),
    generateId: () => `page-${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, 0, millisecond++)),
  });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    projectSlug: "storefront",
    revisionKey: "commit-page",
  });

  const threads = [];
  for (let index = 1; index <= 101; index += 1) {
    threads.push(await service.createRegionComment({
      actor: reviewer,
      tunnelId: "tunnel-page",
      sessionId: "session-page",
      routePath: "/busy",
      body: `Comment ${index}`,
      anchor: {
        type: "REGION_V1",
        selection: "POINT",
        x: index / 202,
        y: 0.5,
        width: 0,
        height: 0,
        document: { width: 1280, height: 2400 },
        viewport: { width: 1280, height: 720 },
      },
    }));
  }

  const firstPage = await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    routePath: "/busy",
  });
  assert.equal(firstPage.comments.length, 100);
  assert.equal(firstPage.comments.at(-1)?.id, threads.at(-1)?.id);
  assert.equal(firstPage.comments[0]?.id, threads[1]?.id);
  assert.equal(firstPage.comments.at(-1)?.pinNumber, 101);
  assert.equal(firstPage.openCount, 101);
  assert.equal(firstPage.pageInfo.hasMore, true);
  assert.equal(typeof firstPage.pageInfo.nextCursor, "string");
  assert.equal(typeof firstPage.eventCursor, "string");
  assert.deepEqual(await service.listEvents({
    actor: reviewer,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    routePath: "/busy",
    afterId: firstPage.eventCursor,
  }), []);

  const olderPage = await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    routePath: "/busy",
    before: firstPage.pageInfo.nextCursor!,
  });
  assert.deepEqual(olderPage.comments.map((thread) => thread.id), [threads[0]!.id]);
  assert.equal(olderPage.comments[0]?.pinNumber, 1);
  assert.equal(olderPage.pageInfo.hasMore, false);

  const replyThread = threads.at(-1)!;
  const replies = [];
  for (let index = 1; index <= 101; index += 1) {
    replies.push(await service.createReply({
      actor: reviewer,
      tunnelId: "tunnel-page",
      sessionId: "session-page",
      commentId: replyThread.id,
      routePath: "/busy",
      body: `Reply ${index}`,
    }));
  }
  const replyPage = await service.listReplyPage({
    actor: reviewer,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    commentId: replyThread.id,
    routePath: "/busy",
  });
  assert.equal(replyPage.replies.length, 100);
  assert.equal(replyPage.replies.at(-1)?.id, replies.at(-1)?.id);
  assert.equal(replyPage.replies[0]?.id, replies[1]?.id);
  assert.equal(replyPage.pageInfo.hasMore, true);
  const olderReplies = await service.listReplyPage({
    actor: reviewer,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    commentId: replyThread.id,
    routePath: "/busy",
    before: replyPage.pageInfo.nextCursor!,
  });
  assert.deepEqual(olderReplies.replies.map((reply) => reply.id), [replies[0]!.id]);

  await service.changePageCommentStatus({
    actor: developer,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    commentId: threads[0]!.id,
    routePath: "/busy",
    expectedStatus: "OPEN",
    status: "RESOLVED",
  });
  assert.equal((await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "tunnel-page",
    sessionId: "session-page",
    routePath: "/busy",
  })).openCount, 100);

  await assert.rejects(
    service.listPageCommentPage({
      actor: reviewer,
      tunnelId: "tunnel-page",
      sessionId: "session-page",
      routePath: "/busy",
      before: "not-a-review-cursor",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "INVALID_INPUT",
  );
});

test("expired Tunnel bindings are rejected and reclaimed without removing review data", async () => {
  let current = new Date("2026-09-01T00:00:00.000Z");
  let id = 0;
  const repository = new InMemoryReviewRepository();
  const service = createReviewService({
    repository,
    generateId: () => `lease-${++id}`,
    now: () => current,
  });
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "leased-tunnel",
    sessionId: "leased-session",
    projectSlug: "storefront",
    revisionKey: "commit-lease",
    expiresAt: new Date(current.getTime() + 1_000),
  });
  const comment = await service.createPageComment({
    actor: reviewer,
    tunnelId: "leased-tunnel",
    sessionId: "leased-session",
    routePath: "/",
    body: "Persistent review data",
  });

  current = new Date(current.getTime() + 1_001);
  await assert.rejects(
    service.getContext({
      actor: reviewer,
      tunnelId: "leased-tunnel",
      sessionId: "leased-session",
    }),
    (error: unknown) => error instanceof ReviewError && error.code === "NOT_FOUND",
  );
  await service.bindTunnel({
    actor: developer,
    tunnelOwnerAccountId: developer.accountId,
    tunnelId: "leased-tunnel",
    sessionId: "replacement-session",
    projectSlug: "storefront",
    revisionKey: "commit-lease",
    expiresAt: new Date(current.getTime() + 1_000),
  });
  assert.equal(repository.bindings.size, 1);
  assert.equal((await service.listPageCommentPage({
    actor: reviewer,
    tunnelId: "leased-tunnel",
    sessionId: "replacement-session",
    routePath: "/",
  })).comments[0]?.id, comment.id);
});

test("review filters search the whole revision and reject cursors from another filter", async () => {
  const repository = new InMemoryReviewRepository();
  let time = Date.now();
  const service = createReviewService({ repository, now: () => new Date(time++) });
  const query = { actor: reviewer, tunnelId: "filter-tunnel", sessionId: "filter-session", routePath: "/filters" };
  await service.bindTunnel({ ...query, actor: developer, tunnelOwnerAccountId: developer.accountId, projectSlug: "filters", revisionKey: "revision" });
  const oldest = await service.createPageComment({ ...query, body: "Old unresolved feedback" });
  for (let index = 0; index < 101; index++) {
    const thread = await service.createPageComment({ ...query, actor: developer, body: `Resolved ${index}` });
    await service.changePageCommentStatus({ ...query, actor: developer, commentId: thread.id, expectedStatus: "OPEN", status: "RESOLVED" });
  }
  assert.equal((await service.listPageCommentPage(query)).comments.some(item => item.id === oldest.id), false);
  const open = await service.listPageCommentPage({ ...query, status: "OPEN" });
  assert.deepEqual(open.comments.map(item => item.id), [oldest.id]);
  assert.equal(open.filteredCount, 1);
  const mine = await service.listPageCommentPage({ ...query, author: "me" });
  assert.deepEqual(mine.comments.map(item => item.id), [oldest.id]);
  const resolved = await service.listPageCommentPage({ ...query, status: "RESOLVED" });
  assert.equal(resolved.filteredCount, 101);
  assert.equal(resolved.openCount, 1);
  assert.ok(resolved.pageInfo.nextCursor);
  assert.equal((await service.listPageCommentPage({ ...query, status: "RESOLVED", before: resolved.pageInfo.nextCursor })).comments.length, 1);
  await assert.rejects(service.listPageCommentPage({ ...query, status: "OPEN", before: resolved.pageInfo.nextCursor }), ReviewError);
  await assert.rejects(service.listPageCommentPage({ ...query, routePath: "/other", status: "RESOLVED", before: resolved.pageInfo.nextCursor }), ReviewError);
});

test("offline review access, workflow versions, history and cross-page inbox remain scoped", async () => {
  const repository = new InMemoryReviewRepository();
  const service = createReviewService({ repository });
  const binding = await service.bindTunnel({ actor: developer, tunnelOwnerAccountId: developer.accountId,
    tunnelId: "offline", sessionId: "offline-session", projectSlug: "offline", revisionKey: "v1" });
  const tunnel = { tunnelId: "offline", sessionId: "offline-session" };
  const thread = await service.createPageComment({ ...tunnel, actor: reviewer, routePath: "/other", body: "Please fix this" });
  const control = { controlProjectId: binding.project.id, controlRevisionId: binding.revision.id };
  await service.removeTunnelBinding(tunnel);
  await assert.rejects(service.getThread({ ...tunnel, actor: reviewer, commentId: thread.id }), { code: "NOT_FOUND" });
  await assert.rejects(service.getThread({ ...control, ...tunnel, actor: reviewer, commentId: thread.id }), { code: "INVALID_INPUT" });
  await assert.rejects(service.getThread({ ...control, controlProjectId: "wrong-project", actor: reviewer, commentId: thread.id }), { code: "NOT_FOUND" });
  await assert.rejects(service.getThreadForControl(outsider, thread.id), { code: "FORBIDDEN" });
  assert.equal((await service.listPageCommentPage({ ...control, actor: reviewer })).comments[0]?.id, thread.id);
  const base = { ...control, commentId: thread.id, routePath: "/other" };
  const disabled = createReviewService({ repository, workflowEnabled: false });
  assert.equal(disabled.getFeatures().canRequestReview, false);
  await assert.rejects(disabled.changePageCommentStatus({ ...base, actor: developer, expectedStatus: "OPEN", status: "NEEDS_REVIEW", expectedWorkflowVersion: 1 }), { code: "FORBIDDEN" });
  await service.createReply({ ...base, actor: developer, body: "Fixed @reviewer" });
  assert.equal((await service.listInbox(reviewer)).notifications.length, 1);
  assert.equal((await service.listInbox(developer)).notifications.length, 0);
  const notification = (await service.listInbox(reviewer)).notifications[0]!;
  await assert.rejects(service.setInboxRead(developer, notification.id, true), { code: "NOT_FOUND" });
  await service.setInboxRead(reviewer, notification.id, true);
  assert.equal((await service.listInbox(reviewer)).unreadCount, 0);
  assert.equal((await service.listMentionCandidates({ ...control, actor: reviewer, prefix: "dev" }))[0]?.username, "developer");
  const request = await service.changePageCommentStatus({ ...base, actor: developer, expectedStatus: "OPEN", status: "NEEDS_REVIEW", expectedWorkflowVersion: 1 });
  assert.equal(request.workflowVersion, 2);
  assert.equal((await service.listPageCommentPage({ ...control, actor: reviewer, status: "OPEN" })).openCount, 1);
  await service.createReply({ ...base, actor: reviewer, body: "Checking now" });
  await assert.rejects(service.changePageCommentStatus({ ...base, actor: { ...reviewer, accountId: "another-reviewer" }, expectedStatus: "NEEDS_REVIEW", status: "RESOLVED", expectedWorkflowVersion: 2 }), { code: "FORBIDDEN" });
  const reopened = await service.changePageCommentStatus({ ...base, actor: reviewer, expectedStatus: "NEEDS_REVIEW", status: "OPEN", expectedWorkflowVersion: 2 });
  assert.equal(reopened.workflowVersion, 3);
  await assert.rejects(service.changePageCommentStatus({ ...base, actor: developer, expectedStatus: "OPEN", status: "RESOLVED", expectedWorkflowVersion: 1 }), { code: "STATE_CONFLICT" });
  await service.changePageCommentStatus({ ...base, actor: developer, expectedStatus: "OPEN", status: "NEEDS_REVIEW", expectedWorkflowVersion: 3 });
  await service.changePageCommentStatus({ ...base, actor: reviewer, expectedStatus: "NEEDS_REVIEW", status: "RESOLVED", expectedWorkflowVersion: 4 });
  const final = await service.getThreadForControl(reviewer, thread.id);
  assert.equal(final.thread.workflowHistory?.length, 4);
  assert.equal(final.thread.resolvedBy?.accountId, reviewer.accountId);
  assert.equal((await disabled.getThreadForControl(reviewer, thread.id)).thread.status, "RESOLVED");
});
