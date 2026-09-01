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

  async listInbox(input: Parameters<ReviewRepository["listInbox"]>[0]) {
    const own = this.notifications.filter(item => item.recipientAccountId === input.actorAccountId);
    const rows = own.filter(item => (!input.unreadOnly || item.readAt === undefined) && (input.before === undefined || BigInt(item.id) < BigInt(input.before)))
      .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    return { notifications: rows.slice(0, 50), unreadCount: own.filter(item => item.readAt === undefined).length,
      ...(rows.length > 50 ? { nextCursor: rows[49]!.id } : {}) };
  }
  async findNotificationForAccount(id: string, accountId: string) {
    return this.notifications.find(item => item.id === id && item.recipientAccountId === accountId);
  }
  async listMentionCandidates(revisionId: string, prefix: string) {
    const participants = new Map<string, string>();
    const project = this.projects.get(this.revisions.get(revisionId)?.projectId ?? "");
    if (project) participants.set(project.ownerAccountId, this.accountUsernames.get(project.ownerAccountId) ?? "");
    for (const thread of this.threads.values()) {
      if (thread.revisionId !== revisionId) continue;
      for (const item of [thread, ...thread.replies]) participants.set(item.author.accountId, item.author.displayName);
    }
    return [...participants].map(([id, displayName]) => ({ username: this.accountUsernames.get(id) ?? "", displayName }))
      .filter(item => item.username && item.username.startsWith(prefix)).sort((a, b) => a.username.localeCompare(b.username)).slice(0, 20);
  }

  async listProjects() {
    return [...this.projects.values()].map(project => {
      const revisions = new Set([...this.revisions.values()].filter(value => value.projectId === project.id).map(value => value.id));
      const threads = [...this.threads.values()].filter(value => revisions.has(value.revisionId));
      return { ...project, openCount: threads.filter(isOpenReviewThread).length,
        lastActivityAt: new Date(Math.max(project.createdAt.getTime(), ...threads.map(value => value.updatedAt.getTime()))) };
    }).sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime());
  }

  async listRevisions(projectId: string) {
    return [...this.revisions.values()].filter(value => value.projectId === projectId).map(revision => ({
      ...revision,
      openCount: [...this.threads.values()].filter(value => value.revisionId === revision.id && isOpenReviewThread(value)).length,
    })).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
  }

  async findRevisionContext(projectId: string | undefined, revisionId: string) {
    const revision = this.revisions.get(revisionId);
    if (revision === undefined || (projectId !== undefined && revision.projectId !== projectId)) return undefined;
    const project = this.projects.get(revision.projectId);
    return project === undefined ? undefined : { project, revision };
  }

  async findThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return undefined;
    const replies = selectReviewPage(thread.replies, undefined, 100);
    return { ...thread, replies: replies.items, replyPageInfo: replies.pageInfo };
  }

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

  async createPageComment(input: Parameters<ReviewRepository["createPageComment"]>[0]) {
    const { thread } = input;
    if (!this.#hasAccess({ ...input, revisionId: thread.revisionId })) return { status: "BINDING_NOT_FOUND" } as const;
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

  async listPageCommentPage(input: Parameters<ReviewRepository["listPageCommentPage"]>[0]): Promise<PageCommentPage> {
    const eventCursor = this.events
      .filter((event) =>
        event.revisionId === input.revisionId && (input.routePath === undefined || event.routePath === input.routePath)
      )
      .at(-1)?.id ?? "0";
    const scoped = [...this.threads.values()]
      .filter(
        (thread) =>
          thread.revisionId === input.revisionId && (input.routePath === undefined || thread.routePath === input.routePath),
      );
    const filtered = scoped.filter(thread =>
      (input.status === undefined || (input.status === "OPEN" ? thread.status !== "RESOLVED" : thread.status === input.status)) &&
      (input.authorAccountId === undefined || thread.author.accountId === input.authorAccountId));
    const selected = selectReviewPage(filtered, input.before, input.limit);
    return {
      comments: selected.items.map((thread) => {
        const replyPage = input.summaryOnly ? { items: [], pageInfo: { hasMore: false } } : selectReviewPage(thread.replies, undefined, input.replyLimit);
        return {
        ...thread,
          replies: replyPage.items,
          replyPageInfo: replyPage.pageInfo,
        };
      }),
      openCount: scoped.filter(isOpenReviewThread).length,
      filteredCount: filtered.length,
      eventCursor,
      pageInfo: selected.pageInfo,
    };
  }

  async listReplyPage(input: Parameters<ReviewRepository["listReplyPage"]>[0]): Promise<ReviewReplyPage | undefined> {
    const thread = this.threads.get(input.threadId);
    if (
      thread === undefined ||
      thread.revisionId !== input.revisionId ||
      thread.routePath !== input.routePath
    ) return undefined;
    const page = selectReviewPage(thread.replies, input.before, input.limit);
    return { replies: page.items, threadStatus: thread.status, pageInfo: page.pageInfo };
  }

  async createReply(input: Parameters<ReviewRepository["createReply"]>[0]) {
    const thread = this.#findBoundThread({ ...input, threadId: input.reply.threadId });
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    if (thread.status === "RESOLVED" || thread.deletedAt !== undefined) {
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
    const recipients = new Set([thread.author.accountId, ...thread.replies.map(reply => reply.author.accountId)]);
    for (const recipientAccountId of recipients) {
      if (recipientAccountId === input.reply.author.accountId || this.notifications.some(item => item.contentId === input.reply.id && item.recipientAccountId === recipientAccountId)) continue;
      this.notifications.push({ id: String(this.#nextNotificationId++), revisionId: thread.revisionId, routePath: thread.routePath,
        threadId: thread.id, contentType: "REPLY", contentId: input.reply.id, reason: "REPLY", sourceKey: "reply:" + input.reply.id, recipientAccountId,
        actor: input.reply.author, createdAt: input.reply.createdAt });
      this.#recordEvent("NOTIFICATION_CREATED", thread, input.reply.author, input.reply.createdAt, recipientAccountId);
    }
    return { status: "CREATED", reply: input.reply } as const;
  }

  async changePageCommentStatus(input: Parameters<ReviewRepository["changePageCommentStatus"]>[0]) {
    const thread = this.#findBoundThread(input);
    if (thread === undefined) return { status: "THREAD_NOT_FOUND" } as const;
    if (thread.status !== input.expectedStatus || (thread.workflowVersion ?? 1) !== input.expectedWorkflowVersion || thread.deletedAt !== undefined) {
      return { status: "STATE_CONFLICT" } as const;
    }
    if (!input.actorCanManageProject && !(thread.author.accountId === input.actor.accountId && thread.status === "NEEDS_REVIEW" && input.status !== "NEEDS_REVIEW")) return { status: "STALE_AUTHORIZATION" } as const;
    const workflowVersion = (thread.workflowVersion ?? 1) + 1;
    const workflowHistory = [...(thread.workflowHistory ?? []), { version: workflowVersion, from: thread.status, to: input.status, actor: input.actor, changedAt: input.changedAt }];
    const { resolvedBy: _resolvedBy, resolvedAt: _resolvedAt, ...base } = thread;
    const changed: PageCommentThread = input.status === "RESOLVED"
      ? {
          ...base,
          workflowVersion, workflowHistory,
          status: "RESOLVED",
          resolvedBy: input.actor,
          resolvedAt: input.changedAt,
          updatedAt: input.changedAt,
        }
      : {
          ...base,
          workflowVersion, workflowHistory,
          status: input.status,
          updatedAt: input.changedAt,
        };
    this.threads.set(thread.id, changed);
    this.#recordEvent("THREAD_STATUS_CHANGED", changed, input.actor, input.changedAt);
    const request = [...(thread.workflowHistory ?? [])].reverse().find(item => item.to === "NEEDS_REVIEW");
    if (thread.status === "NEEDS_REVIEW" && request) {
      for (let index = 0; index < this.notifications.length; index++) {
        const notice = this.notifications[index]!;
        if (notice.threadId === thread.id && notice.recipientAccountId === input.actor.accountId && notice.reason === "WORKFLOW_REQUEST" && notice.workflowVersion === request.version) this.notifications[index] = { ...notice, readAt: notice.readAt ?? input.changedAt };
      }
    }
    const recipientAccountId = input.status === "NEEDS_REVIEW" ? thread.author.accountId : thread.status === "NEEDS_REVIEW" ? request?.actor.accountId : undefined;
    if (recipientAccountId !== undefined && recipientAccountId !== input.actor.accountId) {
      this.notifications.push({ id: String(this.#nextNotificationId++), revisionId: thread.revisionId, routePath: thread.routePath,
        threadId: thread.id, contentType: "COMMENT", contentId: thread.id, recipientAccountId, actor: input.actor, createdAt: input.changedAt,
        reason: input.status === "NEEDS_REVIEW" ? "WORKFLOW_REQUEST" : "WORKFLOW_RESULT", workflowVersion: input.status === "NEEDS_REVIEW" ? workflowVersion : request?.version ?? workflowVersion,
        sourceKey: "workflow:" + thread.id + ":" + workflowVersion });
      this.#recordEvent("NOTIFICATION_CREATED", thread, input.actor, input.changedAt, recipientAccountId);
    }
    return { status: "UPDATED", thread: changed } as const;
  }

  async listReviewEvents(input: Parameters<ReviewRepository["listReviewEvents"]>[0]) {
    if (!this.#hasAccess(input)) return { status: "BINDING_NOT_FOUND" } as const;
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
    if (thread.author.accountId !== input.actor.accountId) return { status: "FORBIDDEN" } as const;
    if (thread.status === "RESOLVED" || thread.deletedAt !== undefined) {
      return { status: "STATE_CONFLICT" } as const;
    }
    if (thread.version !== input.expectedVersion) return { status: "VERSION_CONFLICT" } as const;
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
    if (
      thread.author.accountId !== input.actor.accountId &&
      !input.actorCanManageProject
    ) return { status: "FORBIDDEN" } as const;
    if (thread.deletedAt !== undefined) return { status: "STATE_CONFLICT" } as const;
    if (thread.version !== input.expectedVersion) return { status: "VERSION_CONFLICT" } as const;
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
    if (reply.author.accountId !== input.actor.accountId) return { status: "FORBIDDEN" } as const;
    if (
      thread.status === "RESOLVED" ||
      thread.deletedAt !== undefined ||
      reply.deletedAt !== undefined
    ) return { status: "STATE_CONFLICT" } as const;
    if (reply.version !== input.expectedVersion) return { status: "VERSION_CONFLICT" } as const;
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
    if (
      reply.author.accountId !== input.actor.accountId &&
      !input.actorCanManageProject
    ) return { status: "FORBIDDEN" } as const;
    if (reply.deletedAt !== undefined) return { status: "STATE_CONFLICT" } as const;
    if (reply.version !== input.expectedVersion) return { status: "VERSION_CONFLICT" } as const;
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
    if (!this.#hasAccess(input)) return { status: "BINDING_NOT_FOUND" } as const;
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
    if (!this.#hasAccess(input)) return { status: "BINDING_NOT_FOUND" } as const;
    const index = this.notifications.findIndex((notification) =>
      notification.id === input.notificationId &&
      notification.revisionId === input.revisionId &&
      notification.routePath === input.routePath &&
      notification.recipientAccountId === input.actor.accountId
    );
    if (index < 0) return { status: "NOTIFICATION_NOT_FOUND" } as const;
    const current = this.notifications[index]!;
    const readAt = input.read ? { readAt: current.readAt ?? input.changedAt } : {};
    const { readAt: _previousReadAt, ...retained } = current;
    const changed: ReviewNotification = {
      ...retained,
      id: current.id,
      revisionId: current.revisionId,
      routePath: current.routePath,
      threadId: current.threadId,
      contentType: current.contentType,
      contentId: current.contentId,
      ...(current.reason === undefined ? {} : { reason: current.reason }),
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

  #hasAccess(input: Readonly<{
    revisionId: string; tunnelId?: string; sessionId?: string; controlProjectId?: string;
  }>): boolean {
    if (input.controlProjectId !== undefined) return input.tunnelId === undefined &&
      input.sessionId === undefined && this.revisions.get(input.revisionId)?.projectId === input.controlProjectId;
    const binding = input.tunnelId === undefined ? undefined : this.bindings.get(input.tunnelId);
    return binding !== undefined && binding.sessionId === input.sessionId && binding.revisionId === input.revisionId;
  }

  #findBoundThread(input: Readonly<{
    threadId: string; revisionId: string; routePath: string;
    tunnelId?: string; sessionId?: string; controlProjectId?: string;
  }>): PageCommentThread | undefined {
    const thread = this.threads.get(input.threadId);
    return this.#hasAccess(input) && thread?.revisionId === input.revisionId && thread.routePath === input.routePath
      ? thread : undefined;
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
