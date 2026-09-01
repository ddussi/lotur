import { checkContentMutation } from "./content-mutation-policy.ts";
import type {
  PageCommentPage,
  PageCommentThread,
  ReviewEvent,
  ReviewEventType,
  ReviewIdentity,
  ReviewMentionContentType,
  ReviewNotification,
  ReviewReply,
  ReviewReplyPage,
  ReviewPageCursor,
  ReviewBindingContext,
  ReviewProject,
  ReviewRevision,
  ReviewTunnelBinding,
} from "./model.ts";
import { encodeReviewPageCursor, isOpenReviewThread } from "./model.ts";
import type {
  BindReviewTunnelInput,
  BindReviewTunnelResult,
  ReviewRepository,
} from "./ports.ts";

export class InMemoryReviewRepository implements ReviewRepository {
  readonly projects = new Map<string, ReviewProject>();
  readonly revisions = new Map<string, ReviewRevision>();
  readonly bindings = new Map<string, ReviewTunnelBinding>();
  readonly threads = new Map<string, PageCommentThread>();
  readonly events: ReviewEvent[] = [];
  readonly notifications: ReviewNotification[] = [];
  readonly accountUsernames = new Map<string, string>();
  readonly mentions = new Map<string, ReadonlySet<string>>();
  readonly pinCounters = new Map<string, number>();
  #nextEventId = 1n;
  #nextNotificationId = 1n;

  async checkHealth(): Promise<void> {}

  async bindTunnel(input: BindReviewTunnelInput): Promise<BindReviewTunnelResult> {
    for (const [tunnelId, binding] of this.bindings) {
      if (binding.expiresAt.getTime() <= input.binding.createdAt.getTime()) {
        this.bindings.delete(tunnelId);
      }
    }
    this.accountUsernames.set(input.project.ownerAccountId, input.actorUsername);
    const project = [...this.projects.values()].find(
      (candidate) =>
        candidate.ownerAccountId === input.project.ownerAccountId &&
        candidate.slug === input.project.slug,
    ) ?? input.project;
    const revision = [...this.revisions.values()].find(
      (candidate) => candidate.projectId === project.id && candidate.key === input.revision.key,
    ) ?? {
      ...input.revision,
      projectId: project.id,
    };
    const existing = this.bindings.get(input.binding.tunnelId);
    if (existing !== undefined) {
      if (
        existing.sessionId !== input.binding.sessionId ||
        existing.ownerAccountId !== input.binding.ownerAccountId ||
        existing.revisionId !== revision.id
      ) {
        return { status: "CONFLICT" };
      }
      return {
        status: "BOUND",
        context: { project, revision, binding: existing },
      };
    }
    const binding: ReviewTunnelBinding = {
      ...input.binding,
      revisionId: revision.id,
    };
    this.projects.set(project.id, project);
    this.revisions.set(revision.id, revision);
    this.bindings.set(binding.tunnelId, binding);
    return {
      status: "BOUND",
      context: { project, revision, binding },
    };
  }

  async findBindingContext(input: Readonly<{
    tunnelId: string;
    sessionId: string;
  }>): Promise<ReviewBindingContext | undefined> {
    const binding = this.bindings.get(input.tunnelId);
    if (binding === undefined || binding.sessionId !== input.sessionId) return undefined;
    const revision = this.revisions.get(binding.revisionId);
    if (revision === undefined) return undefined;
    const project = this.projects.get(revision.projectId);
    return project === undefined ? undefined : { project, revision, binding };
  }

  async removeTunnelBinding(input: Readonly<{
    tunnelId: string;
    sessionId: string;
  }>): Promise<void> {
    const binding = this.bindings.get(input.tunnelId);
    if (binding?.sessionId === input.sessionId) this.bindings.delete(input.tunnelId);
  }

  async createPageComment(input: Readonly<{
    thread: PageCommentThread;
    actorUsername: string;
    mentionUsernames: readonly string[];
    actorAuthorizationVersion: number;
    tunnelId: string;
    sessionId: string;
  }>) {
    const { thread } = input;
    const binding = this.bindings.get(input.tunnelId);
    if (
      binding === undefined ||
      binding.sessionId !== input.sessionId ||
      binding.revisionId !== thread.revisionId
    ) return { status: "BINDING_NOT_FOUND" } as const;
    if (this.threads.has(thread.id)) throw new Error("review comment id already exists");
    this.accountUsernames.set(thread.author.accountId, input.actorUsername);
    const storedThread: PageCommentThread = thread.anchor.type === "REGION_V1"
      ? { ...thread, pinNumber: this.#nextPinNumber(thread.revisionId, thread.routePath) }
      : thread;
    this.threads.set(storedThread.id, storedThread);
    this.#recordEvent(
      "COMMENT_CREATED",
      storedThread,
      storedThread.author,
      storedThread.createdAt,
    );
    this.#syncMentions({
      thread: storedThread,
      contentType: "COMMENT",
      contentId: storedThread.id,
      mentionUsernames: input.mentionUsernames,
      actor: storedThread.author,
      occurredAt: storedThread.createdAt,
    });
    return { status: "CREATED", thread: storedThread } as const;
  }

  async listPageCommentPage(input: Readonly<{
    revisionId: string;
    routePath: string;
    before?: ReviewPageCursor;
    limit: number;
    replyLimit: number;
  }>): Promise<PageCommentPage> {
    const eventCursor = this.events
      .filter((event) =>
        event.revisionId === input.revisionId && event.routePath === input.routePath
      )
      .at(-1)?.id ?? "0";
    const scoped = [...this.threads.values()]
      .filter(
        (thread) =>
          thread.revisionId === input.revisionId && thread.routePath === input.routePath,
      );
    const selected = selectReviewPage(scoped, input.before, input.limit);
    return {
      comments: selected.items.map((thread) => {
        const replyPage = selectReviewPage(thread.replies, undefined, input.replyLimit);
        return {
        ...thread,
          replies: replyPage.items,
          replyPageInfo: replyPage.pageInfo,
        };
      }),
      openCount: scoped.filter(isOpenReviewThread).length,
      eventCursor,
      pageInfo: selected.pageInfo,
    };
  }

  async listReplyPage(input: Readonly<{
    revisionId: string;
    routePath: string;
    threadId: string;
    before?: ReviewPageCursor;
    limit: number;
  }>): Promise<ReviewReplyPage | undefined> {
    const thread = this.threads.get(input.threadId);
    if (
      thread === undefined ||
      thread.revisionId !== input.revisionId ||
      thread.routePath !== input.routePath
    ) return undefined;
    const page = selectReviewPage(thread.replies, input.before, input.limit);
    return { replies: page.items, threadStatus: thread.status, pageInfo: page.pageInfo };
  }

  async createReply(input: Readonly<{
    reply: ReviewReply;
    actorUsername: string;
    mentionUsernames: readonly string[];
    revisionId: string;
    routePath: string;
    actorAuthorizationVersion: number;
    tunnelId: string;
    sessionId: string;
  }>) {
    const thread = this.#findBoundThread({
      threadId: input.reply.threadId,
      revisionId: input.revisionId,
      routePath: input.routePath,
      tunnelId: input.tunnelId,
      sessionId: input.sessionId,
    });
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    if (thread.status !== "OPEN" || thread.deletedAt !== undefined) {
      return { status: "STATE_CONFLICT" } as const;
    }
    this.accountUsernames.set(input.reply.author.accountId, input.actorUsername);
    const changedThread = {
      ...thread,
      replies: [...thread.replies, input.reply],
      updatedAt: input.reply.createdAt,
    };
    this.threads.set(thread.id, changedThread);
    this.#recordEvent("REPLY_CREATED", thread, input.reply.author, input.reply.createdAt);
    this.#syncMentions({
      thread: changedThread,
      contentType: "REPLY",
      contentId: input.reply.id,
      mentionUsernames: input.mentionUsernames,
      actor: input.reply.author,
      occurredAt: input.reply.createdAt,
    });
    return { status: "CREATED", reply: input.reply } as const;
  }

  async changePageCommentStatus(input: Parameters<ReviewRepository["changePageCommentStatus"]>[0]) {
    const thread = this.#findBoundThread(input);
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    if (thread.status !== input.expectedStatus || thread.deletedAt !== undefined) {
      return { status: "STATE_CONFLICT" } as const;
    }
    const { resolvedBy: _resolvedBy, resolvedAt: _resolvedAt, ...base } = thread;
    const changed: PageCommentThread = input.status === "RESOLVED"
      ? {
          ...base,
          status: "RESOLVED",
          resolvedBy: input.actor,
          resolvedAt: input.changedAt,
          updatedAt: input.changedAt,
        }
      : {
          ...base,
          status: "OPEN",
          updatedAt: input.changedAt,
        };
    this.threads.set(thread.id, changed);
    this.#recordEvent("THREAD_STATUS_CHANGED", changed, input.actor, input.changedAt);
    return { status: "UPDATED", thread: changed } as const;
  }

  async listReviewEvents(input: Readonly<{
    revisionId: string;
    routePath: string;
    afterId: string;
    limit: number;
    actorAccountId: string;
    actorAuthorizationVersion: number;
    tunnelId: string;
    sessionId: string;
  }>) {
    const binding = this.bindings.get(input.tunnelId);
    if (
      binding === undefined ||
      binding.sessionId !== input.sessionId ||
      binding.revisionId !== input.revisionId
    ) return { status: "BINDING_NOT_FOUND" } as const;
    const afterId = BigInt(input.afterId);
    return {
      status: "FOUND",
      events: this.events
        .filter((event) =>
          event.revisionId === input.revisionId &&
          event.routePath === input.routePath &&
          (event.recipientAccountId === undefined ||
            event.recipientAccountId === input.actorAccountId) &&
          BigInt(event.id) > afterId
        )
        .slice(0, input.limit),
    } as const;
  }

  async updateComment(input: Parameters<ReviewRepository["updateComment"]>[0]) {
    const thread = this.#findBoundThread(input);
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    const decision = checkContentMutation({
      action: "UPDATE", actorAccountId: input.actor.accountId,
      canManageProject: false,
      content: { authorAccountId: thread.author.accountId, version: thread.version, deleted: thread.deletedAt !== undefined },
      thread: { status: thread.status, deleted: thread.deletedAt !== undefined },
      expectedVersion: input.expectedVersion,
    });
    if (decision !== "ALLOWED") return { status: decision };
    const changed: PageCommentThread = {
      ...thread,
      body: input.body,
      version: thread.version + 1,
      updatedAt: input.changedAt,
    };
    this.threads.set(thread.id, changed);
    this.accountUsernames.set(input.actor.accountId, input.actorUsername);
    this.#recordEvent("COMMENT_UPDATED", changed, input.actor, input.changedAt);
    this.#syncMentions({
      thread: changed,
      contentType: "COMMENT",
      contentId: changed.id,
      mentionUsernames: input.mentionUsernames,
      actor: input.actor,
      occurredAt: input.changedAt,
    });
    return { status: "UPDATED", thread: changed } as const;
  }

  async deleteComment(input: Parameters<ReviewRepository["deleteComment"]>[0]) {
    const thread = this.#findBoundThread(input);
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    const decision = checkContentMutation({
      action: "DELETE", actorAccountId: input.actor.accountId,
      canManageProject: input.actorCanManageProject,
      content: { authorAccountId: thread.author.accountId, version: thread.version, deleted: thread.deletedAt !== undefined },
      thread: { status: thread.status, deleted: thread.deletedAt !== undefined },
      expectedVersion: input.expectedVersion,
    });
    if (decision !== "ALLOWED") return { status: decision };
    const changed: PageCommentThread = {
      ...thread,
      body: null,
      version: thread.version + 1,
      deletedBy: input.actor,
      deletedAt: input.changedAt,
      updatedAt: input.changedAt,
    };
    this.threads.set(thread.id, changed);
    this.mentions.delete(this.#mentionKey("COMMENT", thread.id));
    this.#recordEvent("COMMENT_DELETED", changed, input.actor, input.changedAt);
    return { status: "UPDATED", thread: changed } as const;
  }

  async updateReply(input: Parameters<ReviewRepository["updateReply"]>[0]) {
    const thread = this.#findBoundThread(input);
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    const reply = thread.replies.find((candidate) => candidate.id === input.replyId);
    if (reply === undefined) return { status: "REPLY_NOT_FOUND" } as const;
    const decision = checkContentMutation({
      action: "UPDATE", actorAccountId: input.actor.accountId,
      canManageProject: false,
      content: { authorAccountId: reply.author.accountId, version: reply.version, deleted: reply.deletedAt !== undefined },
      thread: { status: thread.status, deleted: thread.deletedAt !== undefined },
      expectedVersion: input.expectedVersion,
    });
    if (decision !== "ALLOWED") return { status: decision };
    const changed: ReviewReply = {
      ...reply,
      body: input.body,
      version: reply.version + 1,
      updatedAt: input.changedAt,
    };
    this.#replaceReply(thread, changed, input.changedAt);
    this.accountUsernames.set(input.actor.accountId, input.actorUsername);
    this.#recordEvent("REPLY_UPDATED", thread, input.actor, input.changedAt);
    this.#syncMentions({
      thread: this.threads.get(thread.id)!,
      contentType: "REPLY",
      contentId: changed.id,
      mentionUsernames: input.mentionUsernames,
      actor: input.actor,
      occurredAt: input.changedAt,
    });
    return { status: "UPDATED", reply: changed } as const;
  }

  async deleteReply(input: Parameters<ReviewRepository["deleteReply"]>[0]) {
    const thread = this.#findBoundThread(input);
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    const reply = thread.replies.find((candidate) => candidate.id === input.replyId);
    if (reply === undefined) return { status: "REPLY_NOT_FOUND" } as const;
    const decision = checkContentMutation({
      action: "DELETE", actorAccountId: input.actor.accountId,
      canManageProject: input.actorCanManageProject,
      content: { authorAccountId: reply.author.accountId, version: reply.version, deleted: reply.deletedAt !== undefined },
      thread: { status: thread.status, deleted: thread.deletedAt !== undefined },
      expectedVersion: input.expectedVersion,
    });
    if (decision !== "ALLOWED") return { status: decision };
    const changed: ReviewReply = {
      ...reply,
      body: null,
      version: reply.version + 1,
      deletedBy: input.actor,
      deletedAt: input.changedAt,
      updatedAt: input.changedAt,
    };
    this.#replaceReply(thread, changed, input.changedAt);
    this.mentions.delete(this.#mentionKey("REPLY", reply.id));
    this.#recordEvent("REPLY_DELETED", thread, input.actor, input.changedAt);
    return { status: "UPDATED", reply: changed } as const;
  }

  async listNotifications(input: Parameters<ReviewRepository["listNotifications"]>[0]) {
    const binding = this.bindings.get(input.tunnelId);
    if (
      binding === undefined ||
      binding.sessionId !== input.sessionId ||
      binding.revisionId !== input.revisionId
    ) return { status: "BINDING_NOT_FOUND" } as const;
    return {
      status: "FOUND",
      notifications: this.notifications
        .filter((notification) =>
          notification.revisionId === input.revisionId &&
          notification.routePath === input.routePath &&
          notification.recipientAccountId === input.actorAccountId
        )
        .sort((left, right) => Number(BigInt(right.id) - BigInt(left.id)))
        .slice(0, input.limit),
    } as const;
  }

  async setNotificationRead(input: Parameters<ReviewRepository["setNotificationRead"]>[0]) {
    const binding = this.bindings.get(input.tunnelId);
    if (
      binding === undefined ||
      binding.sessionId !== input.sessionId ||
      binding.revisionId !== input.revisionId
    ) return { status: "BINDING_NOT_FOUND" } as const;
    const index = this.notifications.findIndex((notification) =>
      notification.id === input.notificationId &&
      notification.revisionId === input.revisionId &&
      notification.routePath === input.routePath &&
      notification.recipientAccountId === input.actor.accountId
    );
    if (index < 0) return { status: "NOTIFICATION_NOT_FOUND" } as const;
    const current = this.notifications[index]!;
    const readAt = input.read ? { readAt: current.readAt ?? input.changedAt } : {};
    const changed: ReviewNotification = {
      id: current.id,
      revisionId: current.revisionId,
      routePath: current.routePath,
      threadId: current.threadId,
      contentType: current.contentType,
      contentId: current.contentId,
      recipientAccountId: current.recipientAccountId,
      actor: current.actor,
      ...readAt,
      createdAt: current.createdAt,
    };
    this.notifications[index] = changed;
    const thread = this.threads.get(changed.threadId);
    if (thread === undefined) throw new Error("notification review thread disappeared");
    this.#recordEvent(
      "NOTIFICATION_READ_CHANGED",
      thread,
      input.actor,
      input.changedAt,
      input.actor.accountId,
    );
    return { status: "UPDATED", notification: changed } as const;
  }

  #findBoundThread(input: Readonly<{
    threadId: string;
    revisionId: string;
    routePath: string;
    tunnelId: string;
    sessionId: string;
  }>): PageCommentThread | undefined {
    const binding = this.bindings.get(input.tunnelId);
    const thread = this.threads.get(input.threadId);
    return binding !== undefined &&
        binding.sessionId === input.sessionId &&
        binding.revisionId === input.revisionId &&
        thread !== undefined &&
        thread.revisionId === input.revisionId &&
        thread.routePath === input.routePath
      ? thread
      : undefined;
  }

  #replaceReply(thread: PageCommentThread, reply: ReviewReply, changedAt: Date): void {
    this.threads.set(thread.id, {
      ...thread,
      replies: thread.replies.map((candidate) => candidate.id === reply.id ? reply : candidate),
      updatedAt: changedAt,
    });
  }

  #nextPinNumber(revisionId: string, routePath: string): number {
    const key = `${revisionId}\u0000${routePath}`;
    const next = this.pinCounters.get(key) ?? 1;
    this.pinCounters.set(key, next + 1);
    return next;
  }

  #recordEvent(
    type: ReviewEventType,
    thread: PageCommentThread,
    actor: ReviewIdentity,
    occurredAt: Date,
    recipientAccountId?: string,
  ): void {
    this.events.push({
      id: String(this.#nextEventId++),
      revisionId: thread.revisionId,
      routePath: thread.routePath,
      threadId: thread.id,
      type,
      actor,
      occurredAt,
      ...(recipientAccountId === undefined ? {} : { recipientAccountId }),
    });
  }

  #mentionKey(contentType: ReviewMentionContentType, contentId: string): string {
    return `${contentType}:${contentId}`;
  }

  #syncMentions(input: Readonly<{
    thread: PageCommentThread;
    contentType: ReviewMentionContentType;
    contentId: string;
    mentionUsernames: readonly string[];
    actor: ReviewIdentity;
    occurredAt: Date;
  }>): void {
    const participants = new Set<string>();
    const revision = this.revisions.get(input.thread.revisionId);
    const project = revision === undefined ? undefined : this.projects.get(revision.projectId);
    if (project !== undefined) participants.add(project.ownerAccountId);
    for (const thread of this.threads.values()) {
      if (thread.revisionId !== input.thread.revisionId) continue;
      participants.add(thread.author.accountId);
      for (const reply of thread.replies) participants.add(reply.author.accountId);
    }
    const requested = new Set(input.mentionUsernames);
    const eligible = new Set(
      [...participants].filter((accountId) =>
        accountId !== input.actor.accountId &&
        requested.has(this.accountUsernames.get(accountId) ?? "")
      ),
    );
    const key = this.#mentionKey(input.contentType, input.contentId);
    const previous = this.mentions.get(key) ?? new Set<string>();
    this.mentions.set(key, eligible);
    for (const recipientAccountId of eligible) {
      if (previous.has(recipientAccountId)) continue;
      const notification: ReviewNotification = {
        id: String(this.#nextNotificationId++),
        revisionId: input.thread.revisionId,
        routePath: input.thread.routePath,
        threadId: input.thread.id,
        contentType: input.contentType,
        contentId: input.contentId,
        recipientAccountId,
        actor: input.actor,
        createdAt: input.occurredAt,
      };
      this.notifications.push(notification);
      this.#recordEvent(
        "NOTIFICATION_CREATED",
        input.thread,
        input.actor,
        input.occurredAt,
        recipientAccountId,
      );
    }
  }
}

function selectReviewPage<T extends Readonly<{ id: string; createdAt: Date }>>(
  values: readonly T[],
  before: ReviewPageCursor | undefined,
  limit: number,
): Readonly<{ items: readonly T[]; pageInfo: Readonly<{ hasMore: boolean; nextCursor?: string }> }> {
  const descending = values
    .filter((value) => before === undefined || compareReviewPosition(value, before) < 0)
    .sort((left, right) => compareReviewPosition(right, left));
  const hasMore = descending.length > limit;
  const selectedDescending = descending.slice(0, limit);
  const oldest = selectedDescending.at(-1);
  return {
    items: [...selectedDescending].reverse(),
    pageInfo: {
      hasMore,
      ...(hasMore && oldest !== undefined
        ? { nextCursor: encodeReviewPageCursor(oldest) }
        : {}),
    },
  };
}

function compareReviewPosition(
  left: Readonly<{ id: string; createdAt: Date }>,
  right: Readonly<{ id: string; createdAt: Date }>,
): number {
  const time = left.createdAt.getTime() - right.createdAt.getTime();
  return time === 0 ? left.id.localeCompare(right.id) : time;
}
