import type { CommentPage, ReplyPage, ReviewContext, PublicNotification } from "./contracts.ts";

export const REVIEW_API = "/_review-tunnel/review";

async function readJson<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
        ? value.error
        : `HTTP_${response.status}`;
    throw new Error(message);
  }
  return value as T;
}

export function createReviewApi(onDenied?: () => void) {
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(REVIEW_API + path, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (response.status === 401 || response.status === 403) onDenied?.();
    return readJson<T>(response);
  };
  return {
    read,
    context: () => read<ReviewContext>("/context"),
    page: (path: string, before?: string) =>
      read<CommentPage>(
        `/comments?path=${encodeURIComponent(path)}${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`,
      ),
    replies: (id: string, path: string, before?: string) =>
      read<ReplyPage>(
        `/comments/${encodeURIComponent(id)}/replies?path=${encodeURIComponent(path)}${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`,
      ),
    notifications: (path: string) =>
      read<{ notifications: PublicNotification[] }>(
        `/notifications?path=${encodeURIComponent(path)}`,
      ),
    mutate: async (path: string, method: "POST" | "PATCH" | "DELETE", command: unknown) => {
      const response = await fetch(REVIEW_API + path, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status === 401 || response.status === 403) onDenied?.();
      return readJson<unknown>(response);
    },
  };
}

export type ReviewApi = ReturnType<typeof createReviewApi>;
