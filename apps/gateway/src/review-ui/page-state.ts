import type { ReviewApi } from "./api.ts";
import type { CommentPage, PublicComment } from "./contracts.ts";

export function emptyCommentPage(): CommentPage {
  return { comments: [], openCount: 0, eventCursor: "0", pageInfo: { hasMore: false } };
}

/** Re-read through the oldest loaded position, including a boundary page.
 * Status filters can remove an item, but its immutable creation position still bounds the range.
 */
export async function refreshLoadedPage(
  api: Pick<ReviewApi, "page" | "replies">,
  path: string,
  current: CommentPage,
): Promise<CommentPage> {
  let latest = await api.page(path);
  const oldest = current.comments[0];
  while (
    oldest !== undefined &&
    !latest.comments.some((item) => item.createdAt < oldest.createdAt ||
      (item.createdAt === oldest.createdAt && item.id <= oldest.id)) &&
    latest.pageInfo.hasMore
  ) {
    const older = await api.page(path, latest.pageInfo.nextCursor);
    latest = {
      ...latest,
      comments: mergeOlder(older.comments, latest.comments),
      pageInfo: older.pageInfo,
    };
  }
  const previous = new Map(current.comments.map((comment) => [comment.id, comment]));
  const comments: PublicComment[] = [];
  for (const comment of latest.comments) {
    let updated = comment;
    const oldestReply = previous.get(comment.id)?.replies[0]?.id;
    while (
      oldestReply !== undefined &&
      !updated.replies.some((reply) => reply.id === oldestReply) &&
      updated.replyPageInfo?.hasMore
    ) {
      const older = await api.replies(comment.id, path, updated.replyPageInfo.nextCursor);
      updated = {
        ...updated,
        replies: mergeOlder(older.replies, updated.replies),
        replyPageInfo: older.pageInfo,
      };
    }
    comments.push(updated);
  }
  return { ...latest, comments };
}

export function mergeOlder<T extends { id: string }>(
  older: readonly T[],
  latest: readonly T[],
): T[] {
  const ids = new Set(older.map((item) => item.id));
  return [...older, ...latest.filter((item) => !ids.has(item.id))];
}

export function createRefreshCoordinator(loadOnce: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let dirty = false;
  return () => {
    if (running !== undefined) {
      dirty = true;
      return running;
    }
    running = (async () => {
      do {
        dirty = false;
        await loadOnce();
      } while (dirty);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
}
