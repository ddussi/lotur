import {
  canEditReviewContent,
  canDeleteReviewContent,
  type PageCommentThread,
  type PageCommentPageItem,
  type ReviewActor,
  type ReviewReply,
  type ReviewThreadStatus,
  type ReviewEvent,
  type ReviewNotification,
} from "../../../packages/review/src/index.ts";

export function publicComment(
  comment: PageCommentThread | PageCommentPageItem,
  actor: ReviewActor,
) {
  const resolution =
    comment.resolvedBy === undefined || comment.resolvedAt === undefined
      ? {}
      : {
          resolvedBy: comment.resolvedBy,
          resolvedAt: comment.resolvedAt.toISOString(),
        };
  const deletion =
    comment.deletedBy === undefined || comment.deletedAt === undefined
      ? {}
      : {
          deletedBy: comment.deletedBy,
          deletedAt: comment.deletedAt.toISOString(),
        };
  return {
    id: comment.id,
    routePath: comment.routePath,
    anchor: comment.anchor,
    ...(comment.pinNumber === undefined ? {} : { pinNumber: comment.pinNumber }),
    body: comment.body,
    version: comment.version,
    status: comment.status,
    author: comment.author,
    ...resolution,
    ...deletion,
    canEdit:
      comment.body !== null &&
      comment.status === "OPEN" &&
      canEditReviewContent(actor, comment.author.accountId),
    canDelete: comment.body !== null && canDeleteReviewContent(actor, comment.author.accountId),
    replies: comment.replies.map((reply) => publicReply(reply, actor, comment.status)),
    ...(Object.hasOwn(comment, "replyPageInfo")
      ? { replyPageInfo: (comment as PageCommentPageItem).replyPageInfo }
      : {}),
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

export function publicReply(
  reply: ReviewReply,
  actor: ReviewActor,
  threadStatus: ReviewThreadStatus,
) {
  const deletion =
    reply.deletedBy === undefined || reply.deletedAt === undefined
      ? {}
      : {
          deletedBy: reply.deletedBy,
          deletedAt: reply.deletedAt.toISOString(),
        };
  return {
    id: reply.id,
    threadId: reply.threadId,
    body: reply.body,
    version: reply.version,
    author: reply.author,
    ...deletion,
    canEdit:
      reply.body !== null &&
      threadStatus === "OPEN" &&
      canEditReviewContent(actor, reply.author.accountId),
    canDelete: reply.body !== null && canDeleteReviewContent(actor, reply.author.accountId),
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
  };
}

export function publicEvent(event: ReviewEvent) {
  return {
    id: event.id,
    type: event.type,
    threadId: event.threadId,
    actor: event.actor,
    occurredAt: event.occurredAt.toISOString(),
  };
}

export function publicNotification(notification: ReviewNotification) {
  return {
    id: notification.id,
    threadId: notification.threadId,
    contentType: notification.contentType,
    contentId: notification.contentId,
    actor: notification.actor,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

export type PublicComment = ReturnType<typeof publicComment>;
export type PublicReply = ReturnType<typeof publicReply>;
export type PublicNotification = ReturnType<typeof publicNotification>;
