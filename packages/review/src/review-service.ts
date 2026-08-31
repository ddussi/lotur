import { randomUUID } from "node:crypto";

import {
  ReviewError,
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
  now?: () => Date;
}>) {
  const generateId = input.generateId ?? randomUUID;
  const now = input.now ?? (() => new Date());

  const requireBindingContext = async (binding: Readonly<{
    actor: ReviewActor;
    tunnelId: string;
    sessionId: string;
  }>): Promise<ReviewBindingContext> => {
    if (!binding.actor.capabilities.canRead) {
      throw new ReviewError("FORBIDDEN", "review access is not allowed");
    }
    const tunnelId = normalizeOpaqueReviewId(binding.tunnelId, "tunnel id");
    const sessionId = normalizeOpaqueReviewId(binding.sessionId, "session id");
    const context = await input.repository.findBindingContext({ tunnelId, sessionId });
    if (context === undefined) {
      throw new ReviewError("NOT_FOUND", "review binding was not found");
    }
    if (context.binding.expiresAt.getTime() <= now().getTime()) {
      await input.repository.removeTunnelBinding({ tunnelId, sessionId });
      throw new ReviewError("NOT_FOUND", "review binding has expired");
    }
    return context;
  };

  const createComment = async (command: Readonly<{
    actor: ReviewActor;
    tunnelId: string;
    sessionId: string;
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
      tunnelId: context.binding.tunnelId,
      sessionId: context.binding.sessionId,
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
    tunnelId: string;
    sessionId: string;
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
    checkHealth(): Promise<void> {
      return input.repository.checkHealth();
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
      tunnelId: string;
      sessionId: string;
    }>) {
      const context = await requireBindingContext(query);
      return {
        project: {
          slug: context.project.slug,
          displayName: context.project.displayName,
        },
        revision: { key: context.revision.key },
        principal: {
          username: query.actor.username,
          displayName: query.actor.displayName,
          canComment: query.actor.capabilities.canComment,
          canManageProject: query.actor.capabilities.canManageProject,
        },
      } as const;
    },

    async createPageComment(command: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
      routePath: string;
      body: string;
    }>): Promise<PageCommentThread> {
      return createComment(command, { type: "PAGE" });
    },

    async createRegionComment(command: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
      routePath: string;
      body: string;
      anchor: unknown;
    }>): Promise<PageCommentThread> {
      return createComment(command, normalizeRegionAnchor(command.anchor));
    },

    async createReply(command: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
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
        tunnelId: context.binding.tunnelId,
        sessionId: context.binding.sessionId,
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
      tunnelId: string;
      sessionId: string;
      commentId: string;
      routePath: string;
      expectedStatus: ReviewThreadStatus;
      status: ReviewThreadStatus;
    }>): Promise<PageCommentThread> {
      if (!command.actor.capabilities.canManageProject) {
        throw new ReviewError("FORBIDDEN", "thread status management is not allowed");
      }
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
        actor: {
          accountId: normalizeOpaqueReviewId(command.actor.accountId, "account id"),
          displayName: command.actor.displayName,
        },
        actorAuthorizationVersion: normalizeAuthorizationVersion(
          command.actor.authorizationVersion,
        ),
        tunnelId: context.binding.tunnelId,
        sessionId: context.binding.sessionId,
        changedAt: now(),
      });
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
      tunnelId: string;
      sessionId: string;
      routePath: string;
      before?: string;
    }>) {
      const context = await requireBindingContext(query);
      return input.repository.listPageCommentPage({
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(query.routePath),
        ...(query.before === undefined
          ? {}
          : { before: normalizeReviewPageCursor(query.before)! }),
        limit: DEFAULT_PAGE_COMMENT_LIMIT,
        replyLimit: DEFAULT_REPLY_LIMIT_PER_THREAD,
      });
    },

    async listReplyPage(query: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
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
      tunnelId: string;
      sessionId: string;
      routePath: string;
      afterId?: string;
    }>) {
      const context = await requireBindingContext(query);
      const result = await input.repository.listReviewEvents({
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(query.routePath),
        afterId: normalizeReviewEventCursor(query.afterId),
        limit: DEFAULT_REVIEW_EVENT_LIMIT,
        actorAccountId: normalizeOpaqueReviewId(query.actor.accountId, "account id"),
        actorAuthorizationVersion: normalizeAuthorizationVersion(
          query.actor.authorizationVersion,
        ),
        tunnelId: context.binding.tunnelId,
        sessionId: context.binding.sessionId,
      });
      if (result.status === "STALE_AUTHORIZATION") {
        throw new ReviewError("FORBIDDEN", "review authorization is stale");
      }
      if (result.status === "BINDING_NOT_FOUND") {
        throw new ReviewError("NOT_FOUND", "review binding was not found");
      }
      return result.events;
    },

    async listNotifications(query: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
      routePath: string;
    }>) {
      const context = await requireBindingContext(query);
      const result = await input.repository.listNotifications({
        revisionId: context.revision.id,
        routePath: normalizeRoutePath(query.routePath),
        limit: DEFAULT_REVIEW_NOTIFICATION_LIMIT,
        actorAccountId: normalizeOpaqueReviewId(query.actor.accountId, "account id"),
        actorAuthorizationVersion: normalizeAuthorizationVersion(query.actor.authorizationVersion),
        tunnelId: context.binding.tunnelId,
        sessionId: context.binding.sessionId,
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
      tunnelId: string;
      sessionId: string;
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
        tunnelId: context.binding.tunnelId,
        sessionId: context.binding.sessionId,
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
      tunnelId: string;
      sessionId: string;
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
        tunnelId: mutation.context.binding.tunnelId,
        sessionId: mutation.context.binding.sessionId,
        changedAt: now(),
      });
      if (result.status === "UPDATED") return result.thread;
      return throwMutationFailure(result.status);
    },

    async deleteComment(command: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
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
        tunnelId: mutation.context.binding.tunnelId,
        sessionId: mutation.context.binding.sessionId,
        changedAt: now(),
      });
      if (result.status === "UPDATED") return result.thread;
      return throwMutationFailure(result.status);
    },

    async updateReply(command: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
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
        tunnelId: mutation.context.binding.tunnelId,
        sessionId: mutation.context.binding.sessionId,
        changedAt: now(),
      });
      if (result.status === "UPDATED") return result.reply;
      return throwMutationFailure(result.status);
    },

    async deleteReply(command: Readonly<{
      actor: ReviewActor;
      tunnelId: string;
      sessionId: string;
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
        tunnelId: mutation.context.binding.tunnelId,
        sessionId: mutation.context.binding.sessionId,
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
