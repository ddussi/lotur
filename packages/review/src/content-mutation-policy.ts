import type { ReviewThreadStatus } from "./model.ts";

export type ContentMutationCheck = Readonly<{
  action: "UPDATE" | "DELETE";
  actorAccountId: string;
  canManageProject: boolean;
  content: Readonly<{ authorAccountId: string; version: number; deleted: boolean }>;
  thread: Readonly<{ status: ReviewThreadStatus; deleted: boolean }>;
  expectedVersion: number;
}>;

/** Evaluate the state read under the repository's transaction lock. */
export function checkContentMutation(
  input: ContentMutationCheck,
): "ALLOWED" | "FORBIDDEN" | "STATE_CONFLICT" | "VERSION_CONFLICT" {
  if (
    input.content.authorAccountId !== input.actorAccountId &&
    (input.action === "UPDATE" || !input.canManageProject)
  )
    return "FORBIDDEN";
  if (
    input.content.deleted ||
    (input.action === "UPDATE" && (input.thread.status === "RESOLVED" || input.thread.deleted))
  )
    return "STATE_CONFLICT";
  if (input.content.version !== input.expectedVersion) return "VERSION_CONFLICT";
  return "ALLOWED";
}
