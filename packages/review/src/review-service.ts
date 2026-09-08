import { createHash, randomUUID } from "node:crypto";

import {
  ReviewError,
  encodeReviewPageCursor,
  extractMentionUsernames,
  normalizeAuthorizationVersion,
  normalizeCommentBody,
  normalizeContentVersion,
  normalizeOpaqueReviewId,
  normalizeProjectSlug,
  normalizeRegionAnchor,
  normalizeReviewPageCursor,
  normalizeReplyBody,
  normalizeReviewEventCursor,
  normalizeReviewNotificationId,
  normalizeReviewUsername,
  normalizeRevisionKey,
  normalizeRoutePath,
  normalizeThreadStatusTransition,
  type PageCommentThread,
  type ReviewActor,
  type ReviewBindingContext,
  type ReviewProject,
  type ReviewRevision,
  type ReviewTunnelBinding,
  type ReviewReply,
  type ReviewAnchor,
  type ReviewThreadStatus,
} from "./model.ts";
import type { ReviewRepository } from "./ports.ts";

const DEFAULT_PAGE_COMMENT_LIMIT = 100;
const DEFAULT_REPLY_LIMIT_PER_THREAD = 100;
const DEFAULT_REVIEW_EVENT_LIMIT = 100;
const DEFAULT_REVIEW_NOTIFICATION_LIMIT = 100;
const DEFAULT_REVIEW_BINDING_TTL_MS = 8 * 60 * 60_000;

export type ReviewService = ReturnType<typeof createReviewService>;

export function createReviewService(input: Readonly<{
  repository: ReviewRepository;
  generateId?: () => string;
  workflowEnabled?: boolean;
  now?: () => Date;
}>) {
  const generateId = input.generateId ?? randomUUID;
  const now = input.now ?? (() => new Date());

  type Context = { project: ReviewProject; revision: ReviewRevision; binding?: ReviewTunnelBinding };
  const repositoryAccess = (context: Context) => context.binding === undefined
    ? { controlProjectId: context.project.id }
    : { tunnelId: context.binding.tunnelId, sessionId: context.binding.sessionId };
  const requireBindingContext = async (binding: Readonly<{
    actor: ReviewActor;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    controlRevisionId?: string;
  }>): Promise<Context> => {
    if (!binding.actor.capabilities.canRead) throw new ReviewError("FORBIDDEN", "review access is not allowed");
    if (binding.controlProjectId !== undefined || binding.controlRevisionId !== undefined) {
      if (binding.tunnelId !== undefined || binding.sessionId !== undefined ||
          binding.controlProjectId === undefined || binding.controlRevisionId === undefined) {
        throw new ReviewError("INVALID_INPUT", "review access scope is invalid");
      }
      const context = await input.repository.findRevisionContext(
        normalizeOpaqueReviewId(binding.controlProjectId, "project id"),
        normalizeOpaqueReviewId(binding.controlRevisionId, "revision id"),
      );
      if (context === undefined) throw new ReviewError("NOT_FOUND", "review revision was not found");
      return context;
    }
    if (binding.tunnelId === undefined || binding.sessionId === undefined) {
      throw new ReviewError("INVALID_INPUT", "review tunnel scope is required");
    }
    const tunnelId = normalizeOpaqueReviewId(binding.tunnelId, "tunnel id");
    const sessionId = normalizeOpaqueReviewId(binding.sessionId, "session id");
    const context = await input.repository.findBindingContext({ tunnelId, sessionId });
    if (context === undefined) throw new ReviewError("NOT_FOUND", "review binding was not found");
    if (context.binding.expiresAt.getTime() <= now().getTime()) {
      await input.repository.removeTunnelBinding({ tunnelId, sessionId });
      throw new ReviewError("NOT_FOUND", "review binding has expired");
    }
    return context;
  };

  const createComment = async (command: Readonly<{
    actor: ReviewActor;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    controlRevisionId?: string;
    routePath: string;
    body: string;
  }>, anchor: ReviewAnchor): Promise<PageCommentThread> => {
    if (!command.actor.capabilities.canComment) {
      throw new ReviewError("FORBIDDEN", "comment creation is not allowed");
    }
    const context = await requireBindingContext(command);
    const createdAt = now();
    const normalizedBody = normalizeCommentBody(command.body);
    const result = await input.repository.createPageComment({
      thread: {
        id: normalizeOpaqueReviewId(generateId(), "comment id"),
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        anchor,
        body: normalizedBody,
        version: 1,
        status: "OPEN",
        author: {
          accountId: normalizeOpaqueReviewId(command.actor.accountId, "account id"),
          displayName: command.actor.displayName,
        },
        replies: [],
        createdAt,
        updatedAt: createdAt,
      },
      actorUsername: normalizeReviewUsername(command.actor.username),
      mentionUsernames: extractMentionUsernames(normalizedBody),
      actorAuthorizationVersion: normalizeAuthorizationVersion(
        command.actor.authorizationVersion,
      ),
      ...repositoryAccess(context),
    });
    if (result.status === "STALE_AUTHORIZATION") {
      throw new ReviewError("FORBIDDEN", "review authorization is stale");
    }
    if (result.status === "BINDING_NOT_FOUND") {
      throw new ReviewError("NOT_FOUND", "review binding was not found");
    }
    return result.thread;
  };

  const mutationContext = async (command: Readonly<{
    actor: ReviewActor;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    controlRevisionId?: string;
  }>) => {
    const context = await requireBindingContext(command);
    return {
      context,
      actor: {
        accountId: normalizeOpaqueReviewId(command.actor.accountId, "account id"),
        displayName: command.actor.displayName,
      },
      actorUsername: normalizeReviewUsername(command.actor.username),
      actorCanManageProject: command.actor.capabilities.canManageProject,
      actorAuthorizationVersion: normalizeAuthorizationVersion(
        command.actor.authorizationVersion,
      ),
    } as const;
  };

  const throwMutationFailure = (status: string): never => {
    if (status === "STALE_AUTHORIZATION" || status === "FORBIDDEN") {
      throw new ReviewError("FORBIDDEN", "review content mutation is not allowed");
    }
    if (status === "THREAD_NOT_FOUND" || status === "REPLY_NOT_FOUND") {
      throw new ReviewError("NOT_FOUND", "review content was not found");
    }
    if (status === "VERSION_CONFLICT") {
      throw new ReviewError("VERSION_CONFLICT", "review content version has changed");
    }
    throw new ReviewError("STATE_CONFLICT", "review content state has changed");
  };

  return {
    getFeatures() { return { workflowVersion: 1, canRequestReview: input.workflowEnabled ?? true }; },

    checkHealth(): Promise<void> {
      return input.repository.checkHealth();
    },

    async listInbox(actor: ReviewActor, query: { before?: string; unreadOnly?: boolean } = {}) {
      if (!actor.capabilities.canRead) throw new ReviewError("FORBIDDEN", "review access is not allowed");
      return input.repository.listInbox({ actorAccountId: actor.accountId, unreadOnly: query.unreadOnly ?? false,
        ...(query.before === undefined ? {} : { before: normalizeReviewNotificationId(query.before) }) });
    },

    async setInboxRead(actor: ReviewActor, id: string, read: boolean, threadId?: string) {
      if (!actor.capabilities.canRead) throw new ReviewError("FORBIDDEN", "review access is not allowed");
      const notification = await input.repository.findNotificationForAccount(normalizeReviewNotificationId(id), actor.accountId);
      if (notification === undefined || (threadId !== undefined && notification.threadId !== threadId)) throw new ReviewError("NOT_FOUND", "notification was not found");
      const context = await input.repository.findRevisionContext(undefined, notification.revisionId);
      if (context === undefined) throw new ReviewError("NOT_FOUND", "review revision was not found");
      const result = await input.repository.setNotificationRead({ notificationId: id, revisionId: notification.revisionId,
        routePath: notification.routePath, controlProjectId: context.project.id, read,
        actor: { accountId: actor.accountId, displayName: actor.displayName }, actorAuthorizationVersion: actor.authorizationVersion, changedAt: now() });
      if (result.status !== "UPDATED") throw new ReviewError(result.status === "STALE_AUTHORIZATION" ? "FORBIDDEN" : "NOT_FOUND", "notification update failed");
      return result.notification;
    },

    async listMentionCandidates(query: Parameters<typeof requireBindingContext>[0] & { prefix: string }) {
      const context = await requireBindingContext(query);
      if (!/^[a-z0-9._-]{0,63}$/.test(query.prefix)) throw new ReviewError("INVALID_INPUT", "mention prefix is invalid");
      return input.repository.listMentionCandidates(context.revision.id, query.prefix);
    },

    async listProjects(actor: ReviewActor) {
      if (!actor.capabilities.canRead) throw new ReviewError("FORBIDDEN", "review access is not allowed");
      return input.repository.listProjects();
    },

    async listRevisions(actor: ReviewActor, projectId: string) {
      if (!actor.capabilities.canRead) throw new ReviewError("FORBIDDEN", "review access is not allowed");
      return input.repository.listRevisions(normalizeOpaqueReviewId(projectId, "project id"));
    },

    async getThreadForControl(actor: ReviewActor, threadId: string) {
      if (!actor.capabilities.canRead) throw new ReviewError("FORBIDDEN", "review access is not allowed");
      const thread = await input.repository.findThread(normalizeOpaqueReviewId(threadId, "thread id"));
      if (thread === undefined) throw new ReviewError("NOT_FOUND", "review thread was not found");
      const context = await input.repository.findRevisionContext(undefined, thread.revisionId);
      if (context !== undefined) return { ...context, thread };
      throw new ReviewError("NOT_FOUND", "review revision was not found");
    },

    async getThread(query: Parameters<typeof requireBindingContext>[0] & { commentId: string; routePath?: string }) {
      const context = await requireBindingContext(query);
      const thread = await input.repository.findThread(normalizeOpaqueReviewId(query.commentId, "comment id"));
      if (thread === undefined || thread.revisionId !== context.revision.id ||
        (query.routePath !== undefined && thread.routePath !== normalizeRoutePath(query.routePath))) throw new ReviewError("NOT_FOUND", "review thread was not found");
      return thread;
    },

    async bindTunnel(command: Readonly<{
      actor: ReviewActor;
      tunnelOwnerAccountId: string;
      tunnelId: string;
      sessionId: string;
      projectSlug: string;
      revisionKey: string;
      expiresAt?: Date;
    }>): Promise<ReviewBindingContext> {
      if (
        !command.actor.capabilities.canManageProject ||
        command.actor.accountId !== command.tunnelOwnerAccountId
      ) {
        throw new ReviewError("FORBIDDEN", "project binding is not allowed");
      }
      const accountId = normalizeOpaqueReviewId(command.actor.accountId, "account id");
      const tunnelId = normalizeOpaqueReviewId(command.tunnelId, "tunnel id");
      const sessionId = normalizeOpaqueReviewId(command.sessionId, "session id");
      const projectSlug = normalizeProjectSlug(command.projectSlug);
      const revisionKey = normalizeRevisionKey(command.revisionKey);
      const createdAt = now();
      const expiresAt = command.expiresAt ?? new Date(
        createdAt.getTime() + DEFAULT_REVIEW_BINDING_TTL_MS,
      );
      if (
        !(expiresAt instanceof Date) ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= createdAt.getTime()
      ) throw new ReviewError("INVALID_INPUT", "review binding expiry is invalid");
      const projectId = normalizeOpaqueReviewId(generateId(), "project id");
      const revisionId = normalizeOpaqueReviewId(generateId(), "revision id");
      const result = await input.repository.bindTunnel({
        project: {
          id: projectId,
          ownerAccountId: accountId,
          slug: projectSlug,
          displayName: projectSlug,
          createdAt,
        },
        revision: {
          id: revisionId,
          projectId,
          key: revisionKey,
          createdByAccountId: accountId,
          createdAt,
        },
        binding: {
          tunnelId,
          sessionId,
          revisionId,
          ownerAccountId: accountId,
          createdAt,
          expiresAt,
        },
        actorUsername: normalizeReviewUsername(command.actor.username),
        actorAuthorizationVersion: normalizeAuthorizationVersion(
          command.actor.authorizationVersion,
        ),
      });
      if (result.status === "STALE_AUTHORIZATION") {
        throw new ReviewError("FORBIDDEN", "review authorization is stale");
      }
      if (result.status === "CONFLICT") {
        throw new ReviewError("CONFLICT", "Tunnel already has a different review binding");
      }
      return result.context;
    },

    async getContext(query: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
    }>) {
      const context = await requireBindingContext(query);
      return {
        project: {
          id: context.project.id,
          slug: context.project.slug,
          displayName: context.project.displayName,
        },
        revision: { id: context.revision.id, key: context.revision.key },
        features: { workflowVersion: 1, canRequestReview: input.workflowEnabled ?? true },
        principal: {
          accountId: query.actor.accountId,
          username: query.actor.username,
          displayName: query.actor.displayName,
          canComment: query.actor.capabilities.canComment,
          canManageProject: query.actor.capabilities.canManageProject,
        },
      } as const;
    },

    async createPageComment(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      routePath: string;
      body: string;
    }>): Promise<PageCommentThread> {
      return createComment(command, { type: "PAGE" });
    },

    async createRegionComment(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      routePath: string;
      body: string;
      anchor: unknown;
    }>): Promise<PageCommentThread> {
      return createComment(command, normalizeRegionAnchor(command.anchor));
    },

    async createReply(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      commentId: string;
      routePath: string;
      body: string;
    }>): Promise<ReviewReply> {
      if (!command.actor.capabilities.canComment) {
        throw new ReviewError("FORBIDDEN", "reply creation is not allowed");
      }
      const context = await requireBindingContext(command);
      const createdAt = now();
      const reply: ReviewReply = {
        id: normalizeOpaqueReviewId(generateId(), "reply id"),
        threadId: normalizeOpaqueReviewId(command.commentId, "comment id"),
        body: normalizeReplyBody(command.body),
        version: 1,
        author: {
          accountId: normalizeOpaqueReviewId(command.actor.accountId, "account id"),
          displayName: command.actor.displayName,
        },
        createdAt,
        updatedAt: createdAt,
      };
      const mentionUsernames = extractMentionUsernames(reply.body!);
      const result = await input.repository.createReply({
        reply,
        actorUsername: normalizeReviewUsername(command.actor.username),
        mentionUsernames,
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        actorAuthorizationVersion: normalizeAuthorizationVersion(
          command.actor.authorizationVersion,
        ),
        ...repositoryAccess(context),
      });
      if (result.status === "STALE_AUTHORIZATION") {
        throw new ReviewError("FORBIDDEN", "review authorization is stale");
      }
      if (result.status === "THREAD_NOT_FOUND") {
        throw new ReviewError("NOT_FOUND", "review thread was not found");
      }
      if (result.status === "STATE_CONFLICT") {
        throw new ReviewError("STATE_CONFLICT", "resolved review thread cannot accept replies");
      }
      return result.reply;
    },

    async changePageCommentStatus(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      commentId: string;
      routePath: string;
      expectedStatus: ReviewThreadStatus;
      expectedWorkflowVersion?: number;
      status: ReviewThreadStatus;
    }>): Promise<PageCommentThread> {
      if (!command.actor.capabilities.canComment) {
        throw new ReviewError("FORBIDDEN", "thread status management is not allowed");
      }
      if (command.status === "NEEDS_REVIEW" && input.workflowEnabled === false) throw new ReviewError("FORBIDDEN", "review requests are not enabled yet");
      const context = await requireBindingContext(command);
      const transition = normalizeThreadStatusTransition(
        command.expectedStatus,
        command.status,
      );
      const result = await input.repository.changePageCommentStatus({
        threadId: normalizeOpaqueReviewId(command.commentId, "comment id"),
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        ...transition,
        expectedWorkflowVersion: normalizeContentVersion(command.expectedWorkflowVersion ?? 1),
        actorCanManageProject: command.actor.capabilities.canManageProject,
        actor: {
          accountId: normalizeOpaqueReviewId(command.actor.accountId, "account id"),
          displayName: command.actor.displayName,
        },
        actorAuthorizationVersion: normalizeAuthorizationVersion(
          command.actor.authorizationVersion,
        ),
        ...repositoryAccess(context),
        changedAt: now(),
      });
      if (result.status === "REVIEWER_UNAVAILABLE") throw new ReviewError("REVIEWER_UNAVAILABLE", "the original reviewer is disabled or has no review access");
      if (result.status === "STALE_AUTHORIZATION") {
        throw new ReviewError("FORBIDDEN", "review authorization is stale");
      }
      if (result.status === "THREAD_NOT_FOUND") {
        throw new ReviewError("NOT_FOUND", "review thread was not found");
      }
      if (result.status === "STATE_CONFLICT") {
        throw new ReviewError("STATE_CONFLICT", "review thread status has changed");
      }
      return result.thread;
    },

    async listPageCommentPage(query: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      routePath?: string;
      before?: string;
      status?: "OPEN" | "RESOLVED" | "ALL";
      author?: "me";
    }>) {
      const context = await requireBindingContext(query);
      const routePath = query.routePath === undefined && query.controlProjectId !== undefined
        ? undefined : normalizeRoutePath(query.routePath ?? "");
      if (query.status !== undefined && !["OPEN", "RESOLVED", "ALL"].includes(query.status)) {
        throw new ReviewError("INVALID_INPUT", "review status filter is invalid");
      }
      if (query.author !== undefined && query.author !== "me") {
        throw new ReviewError("INVALID_INPUT", "review author filter is invalid");
      }
      const status = query.status === "ALL" ? undefined : query.status;
      const authorAccountId = query.author === "me" ? query.actor.accountId : undefined;
      const scope = createHash("sha256").update(JSON.stringify([
        context.revision.id, routePath, status ?? "ALL", authorAccountId ?? null,
      ])).digest("hex");
      const before = normalizeReviewPageCursor(query.before);
      if (before !== undefined && before.scope !== scope &&
          (before.scope !== undefined || status !== undefined || authorAccountId !== undefined)) {
        throw new ReviewError("INVALID_INPUT", "review cursor does not match its filters");
      }
      const page = await input.repository.listPageCommentPage({
        revisionId: context.revision.id,
        ...(routePath === undefined ? {} : { routePath }),
        ...(before === undefined ? {} : { before }),
        ...(status === undefined ? {} : { status }),
        ...(authorAccountId === undefined ? {} : { authorAccountId }),
        limit: DEFAULT_PAGE_COMMENT_LIMIT,
        summaryOnly: query.controlProjectId !== undefined,
        replyLimit: DEFAULT_REPLY_LIMIT_PER_THREAD,
      });
      const next = normalizeReviewPageCursor(page.pageInfo.nextCursor);
      return {
        ...page,
        pageInfo: next === undefined ? page.pageInfo : {
          ...page.pageInfo, nextCursor: encodeReviewPageCursor({ ...next, scope }),
        },
      };
    },

    async listReplyPage(query: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      commentId: string;
      routePath: string;
      before?: string;
    }>) {
      const context = await requireBindingContext(query);
      const page = await input.repository.listReplyPage({
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(query.routePath),
        threadId: normalizeOpaqueReviewId(query.commentId, "comment id"),
        ...(query.before === undefined
          ? {}
          : { before: normalizeReviewPageCursor(query.before)! }),
        limit: DEFAULT_REPLY_LIMIT_PER_THREAD,
      });
      if (page === undefined) {
        throw new ReviewError("NOT_FOUND", "review thread was not found");
      }
      return page;
    },

    async listEvents(query: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      routePath: string;
      afterId?: string;
    }>) {
      const context = await requireBindingContext(query);
      const result = await input.repository.listReviewEvents({
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(query.routePath),
        afterId: normalizeReviewEventCursor(query.afterId),
        requireContinuity: query.afterId !== undefined,
        limit: DEFAULT_REVIEW_EVENT_LIMIT,
        actorAccountId: normalizeOpaqueReviewId(query.actor.accountId, "account id"),
        actorAuthorizationVersion: normalizeAuthorizationVersion(
          query.actor.authorizationVersion,
        ),
        ...repositoryAccess(context),
      });
      if (result.status === "STALE_AUTHORIZATION") {
        throw new ReviewError("FORBIDDEN", "review authorization is stale");
      }
      if (result.status === "BINDING_NOT_FOUND") {
        throw new ReviewError("NOT_FOUND", "review binding was not found");
      }
      if (result.status === "CURSOR_EXPIRED") {
        throw new ReviewError("CURSOR_EXPIRED", "review events were removed; reload the page data before resuming");
      }
      return result.events;
    },

    async listNotifications(query: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      routePath: string;
    }>) {
      const context = await requireBindingContext(query);
      const result = await input.repository.listNotifications({
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(query.routePath),
        limit: DEFAULT_REVIEW_NOTIFICATION_LIMIT,
        actorAccountId: normalizeOpaqueReviewId(query.actor.accountId, "account id"),
        actorAuthorizationVersion: normalizeAuthorizationVersion(query.actor.authorizationVersion),
        ...repositoryAccess(context),
      });
      if (result.status === "STALE_AUTHORIZATION") {
        throw new ReviewError("FORBIDDEN", "review authorization is stale");
      }
      if (result.status === "BINDING_NOT_FOUND") {
        throw new ReviewError("NOT_FOUND", "review binding was not found");
      }
      return result.notifications;
    },

    async setNotificationRead(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      notificationId: string;
      routePath: string;
      read: boolean;
    }>) {
      const context = await requireBindingContext(command);
      const result = await input.repository.setNotificationRead({
        notificationId: normalizeReviewNotificationId(command.notificationId),
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        read: command.read,
        actor: {
          accountId: normalizeOpaqueReviewId(command.actor.accountId, "account id"),
          displayName: command.actor.displayName,
        },
        actorAuthorizationVersion: normalizeAuthorizationVersion(command.actor.authorizationVersion),
        ...repositoryAccess(context),
        changedAt: now(),
      });
      if (result.status === "STALE_AUTHORIZATION") {
        throw new ReviewError("FORBIDDEN", "review authorization is stale");
      }
      if (result.status === "BINDING_NOT_FOUND" || result.status === "NOTIFICATION_NOT_FOUND") {
        throw new ReviewError("NOT_FOUND", "review notification was not found");
      }
      return result.notification;
    },

    async updateComment(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      commentId: string;
      routePath: string;
      expectedVersion: number;
      body: string;
    }>): Promise<PageCommentThread> {
      if (!command.actor.capabilities.canComment) {
        throw new ReviewError("FORBIDDEN", "comment editing is not allowed");
      }
      const mutation = await mutationContext(command);
      const normalizedBody = normalizeCommentBody(command.body);
      const result = await input.repository.updateComment({
        threadId: normalizeOpaqueReviewId(command.commentId, "comment id"),
        revisionId: mutation.context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        expectedVersion: normalizeContentVersion(command.expectedVersion),
        body: normalizedBody,
        actorUsername: mutation.actorUsername,
        mentionUsernames: extractMentionUsernames(normalizedBody),
        actor: mutation.actor,
        actorAuthorizationVersion: mutation.actorAuthorizationVersion,
        ...repositoryAccess(mutation.context),
        changedAt: now(),
      });
      if (result.status === "UPDATED") return result.thread;
      return throwMutationFailure(result.status);
    },

    async deleteComment(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      commentId: string;
      routePath: string;
      expectedVersion: number;
    }>): Promise<PageCommentThread> {
      if (!command.actor.capabilities.canComment && !command.actor.capabilities.canManageProject) {
        throw new ReviewError("FORBIDDEN", "comment deletion is not allowed");
      }
      const mutation = await mutationContext(command);
      const result = await input.repository.deleteComment({
        threadId: normalizeOpaqueReviewId(command.commentId, "comment id"),
        revisionId: mutation.context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        expectedVersion: normalizeContentVersion(command.expectedVersion),
        actor: mutation.actor,
        actorCanManageProject: mutation.actorCanManageProject,
        actorAuthorizationVersion: mutation.actorAuthorizationVersion,
        ...repositoryAccess(mutation.context),
        changedAt: now(),
      });
      if (result.status === "UPDATED") return result.thread;
      return throwMutationFailure(result.status);
    },

    async updateReply(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      commentId: string;
      replyId: string;
      routePath: string;
      expectedVersion: number;
      body: string;
    }>): Promise<ReviewReply> {
      if (!command.actor.capabilities.canComment) {
        throw new ReviewError("FORBIDDEN", "reply editing is not allowed");
      }
      const mutation = await mutationContext(command);
      const normalizedBody = normalizeReplyBody(command.body);
      const result = await input.repository.updateReply({
        threadId: normalizeOpaqueReviewId(command.commentId, "comment id"),
        replyId: normalizeOpaqueReviewId(command.replyId, "reply id"),
        revisionId: mutation.context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        expectedVersion: normalizeContentVersion(command.expectedVersion),
        body: normalizedBody,
        actorUsername: mutation.actorUsername,
        mentionUsernames: extractMentionUsernames(normalizedBody),
        actor: mutation.actor,
        actorAuthorizationVersion: mutation.actorAuthorizationVersion,
        ...repositoryAccess(mutation.context),
        changedAt: now(),
      });
      if (result.status === "UPDATED") return result.reply;
      return throwMutationFailure(result.status);
    },

    async deleteReply(command: Readonly<{
      actor: ReviewActor;
      tunnelId?: string;
      sessionId?: string;
      controlProjectId?: string;
      controlRevisionId?: string;
      commentId: string;
      replyId: string;
      routePath: string;
      expectedVersion: number;
    }>): Promise<ReviewReply> {
      if (!command.actor.capabilities.canComment && !command.actor.capabilities.canManageProject) {
        throw new ReviewError("FORBIDDEN", "reply deletion is not allowed");
      }
      const mutation = await mutationContext(command);
      const result = await input.repository.deleteReply({
        threadId: normalizeOpaqueReviewId(command.commentId, "comment id"),
        replyId: normalizeOpaqueReviewId(command.replyId, "reply id"),
        revisionId: mutation.context.revision.id,
        routePath: normalizeRoutePath(command.routePath),
        expectedVersion: normalizeContentVersion(command.expectedVersion),
        actor: mutation.actor,
        actorCanManageProject: mutation.actorCanManageProject,
        actorAuthorizationVersion: mutation.actorAuthorizationVersion,
        ...repositoryAccess(mutation.context),
        changedAt: now(),
      });
      if (result.status === "UPDATED") return result.reply;
      return throwMutationFailure(result.status);
    },

    removeTunnelBinding(binding: Readonly<{
      tunnelId: string;
      sessionId: string;
    }>): Promise<void> {
      return input.repository.removeTunnelBinding({
        tunnelId: normalizeOpaqueReviewId(binding.tunnelId, "tunnel id"),
        sessionId: normalizeOpaqueReviewId(binding.sessionId, "session id"),
      });
    },
  };
}
