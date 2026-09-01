import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../../../packages/auth/src/index.ts";
import { ReviewError, type ReviewService } from "../../../packages/review/src/index.ts";
import {
  publicComment, publicReply, publicNotification, readJsonObject, requireExactObjectKeys,
  requiredString, requiredBoolean, requiredThreadStatus, requiredContentVersion,
  reviewActorFromPrincipal, writeJson,
} from "./review-http.ts";
import { REVIEW_CONTROL_SOURCE, REVIEW_CONTROL_HTML } from "./review-control-view.ts";

export function createReviewControlHandler(input: Readonly<{
  service: ReviewService;
  isReadOnly(): boolean;
  activeTargets(principal: Principal, revisionId: string, threadId: string): Promise<readonly { url: string; label: string }[]>;
}>) {
  return {
    matches(_method: string, path: string) {
      return path === "/reviews" || path.startsWith("/reviews/") || path.startsWith("/api/reviews/");
    },
    async handle({ request, response, principal }: Readonly<{
      request: IncomingMessage; response: ServerResponse; principal: Principal;
    }>) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      const url = new URL(request.url ?? "/", "http://control.invalid");
      const actor = reviewActorFromPrincipal(principal);
      const service = input.service;
      try {
        if (request.method === "GET" && url.pathname === "/reviews/app.js") {
          response.setHeader("Content-Type", "application/javascript; charset=utf-8");
          response.end(REVIEW_CONTROL_SOURCE);
          return;
        }
        if (request.method === "GET" && /^\/reviews(?:\/(?:projects|threads)\/[a-zA-Z0-9_-]+)?$/.test(url.pathname)) {
          response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(REVIEW_CONTROL_HTML);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/reviews/projects") {
          writeJson(response, 200, { projects: await service.listProjects(actor) });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/reviews/notifications") {
          if ([...url.searchParams.keys()].some(key => !["before", "unread"].includes(key) || url.searchParams.getAll(key).length !== 1) || (url.searchParams.has("unread") && url.searchParams.get("unread") !== "true")) throw new ReviewError("INVALID_INPUT", "notification filter is invalid");
          const page = await service.listInbox(actor, { unreadOnly: url.searchParams.has("unread"), ...(url.searchParams.has("before") ? { before: url.searchParams.get("before")! } : {}) });
          writeJson(response, 200, { ...page, notifications: page.notifications.map(publicNotification) });
          return;
        }
        const notificationMatch = /^\/api\/reviews\/notifications\/([0-9]+)$/.exec(url.pathname);
        if (request.method === "PATCH" && notificationMatch?.[1]) {
          if (input.isReadOnly()) { writeJson(response, 503, { error: "REVIEWS_READ_ONLY" }); return; }
          const command = await readJsonObject(request, 1024);
          requireExactObjectKeys(command, Object.hasOwn(command, "threadId") ? ["read", "threadId"] : ["read"]);
          writeJson(response, 200, { notification: publicNotification(await service.setInboxRead(actor, notificationMatch[1], requiredBoolean(command, "read"), command.threadId === undefined ? undefined : requiredString(command, "threadId"))) });
          return;
        }
        const mentionMatch = /^\/api\/reviews\/comments\/([a-zA-Z0-9_-]+)\/mentions$/.exec(url.pathname);
        if (request.method === "GET" && mentionMatch?.[1]) {
          const detail = await service.getThreadForControl(actor, mentionMatch[1]);
          writeJson(response, 200, { candidates: await service.listMentionCandidates({ actor, controlProjectId: detail.project.id, controlRevisionId: detail.revision.id, prefix: url.searchParams.get("prefix") ?? "" }) });
          return;
        }
        const projectMatch = /^\/api\/reviews\/projects\/([a-zA-Z0-9_-]+)(?:\/revisions\/([a-zA-Z0-9_-]+)\/comments)?$/.exec(url.pathname);
        if (request.method === "GET" && projectMatch?.[1]) {
          if (!projectMatch[2]) {
            writeJson(response, 200, { revisions: await service.listRevisions(actor, projectMatch[1]) });
          } else {
            const status = url.searchParams.get("status") ?? "ALL";
            const author = url.searchParams.get("author");
            if (!["OPEN", "RESOLVED", "ALL"].includes(status) || (author !== null && author !== "me") ||
              [...url.searchParams.keys()].some(key => !["status", "author", "before", "path"].includes(key) || url.searchParams.getAll(key).length !== 1)) {
              throw new ReviewError("INVALID_INPUT", "review filters are invalid");
            }
            const page = await service.listPageCommentPage({ actor, controlProjectId: projectMatch[1], controlRevisionId: projectMatch[2],
              status: status as "OPEN" | "RESOLVED" | "ALL",
              ...(author === null ? {} : { author: "me" as const }),
              ...(url.searchParams.has("before") ? { before: url.searchParams.get("before")! } : {}),
              ...(url.searchParams.has("path") ? { routePath: url.searchParams.get("path")! } : {}),
            });
            writeJson(response, 200, { ...page, comments: page.comments.map(comment => publicComment(comment, actor)) });
          }
          return;
        }
        const match = /^\/api\/reviews\/comments\/([a-zA-Z0-9_-]+)(?:\/(status|replies)(?:\/([a-zA-Z0-9_-]+))?)?$/.exec(url.pathname);
        if (!match?.[1]) { writeJson(response, 404, { error: "REVIEW_NOT_FOUND" }); return; }
        const detail = await service.getThreadForControl(actor, match[1]);
        const base = { actor, controlProjectId: detail.project.id, controlRevisionId: detail.revision.id,
          commentId: detail.thread.id, routePath: detail.thread.routePath };
        if (request.method === "GET") {
          if (match[2] === "replies" && !match[3]) {
            const page = await service.listReplyPage({ ...base,
              ...(url.searchParams.has("before") ? { before: url.searchParams.get("before")! } : {}) });
            writeJson(response, 200, { ...page, replies: page.replies.map(reply => publicReply(reply, actor, page.threadStatus)) });
          } else if (!match[2]) {
            writeJson(response, 200, { project: detail.project, revision: detail.revision,
              comment: publicComment(detail.thread, actor), features: service.getFeatures(), readOnly: input.isReadOnly(),
              principal: { accountId: actor.accountId, ...actor.capabilities, canComment: actor.capabilities.canComment && !input.isReadOnly() },
              targets: input.isReadOnly() ? [] : await input.activeTargets(principal, detail.revision.id, detail.thread.id),
            });
          } else writeJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
          return;
        }
        if (input.isReadOnly()) { writeJson(response, 503, { error: "REVIEWS_READ_ONLY" }); return; }
        if (url.search !== "") throw new ReviewError("INVALID_INPUT", "mutation query is invalid");
        const command = await readJsonObject(request, 64 * 1024);
        if (requiredString(command, "path") !== base.routePath) throw new ReviewError("NOT_FOUND", "review page does not match");
        if (match[2] === "status" && !match[3] && request.method === "PATCH") {
          requireExactObjectKeys(command, ["path", "expectedStatus", "status", "expectedWorkflowVersion"]);
          const comment = await service.changePageCommentStatus({ ...base,
            expectedWorkflowVersion: requiredContentVersion(command, "expectedWorkflowVersion"), expectedStatus: requiredThreadStatus(command, "expectedStatus"), status: requiredThreadStatus(command, "status") });
          writeJson(response, 200, { comment: publicComment(comment, actor) });
        } else if (match[2] === "replies" && !match[3] && request.method === "POST") {
          requireExactObjectKeys(command, ["path", "body"]);
          const reply = await service.createReply({ ...base, body: requiredString(command, "body") });
          writeJson(response, 201, { reply: publicReply(reply, actor, detail.thread.status) });
        } else if ((!match[2] || (match[2] === "replies" && match[3])) && ["PATCH", "DELETE"].includes(request.method ?? "")) {
          requireExactObjectKeys(command, request.method === "PATCH" ? ["path", "expectedVersion", "body"] : ["path", "expectedVersion"]);
          const versioned = { ...base, expectedVersion: requiredContentVersion(command, "expectedVersion") };
          if (match[3]) {
            const reply = request.method === "PATCH"
              ? await service.updateReply({ ...versioned, replyId: match[3], body: requiredString(command, "body") })
              : await service.deleteReply({ ...versioned, replyId: match[3] });
            writeJson(response, 200, { reply: publicReply(reply, actor, detail.thread.status) });
          } else {
            const comment = request.method === "PATCH"
              ? await service.updateComment({ ...versioned, body: requiredString(command, "body") })
              : await service.deleteComment(versioned);
            writeJson(response, 200, { comment: publicComment(comment, actor) });
          }
        } else writeJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      } catch (error) {
        const status = error instanceof ReviewError
          ? error.code === "INVALID_INPUT" ? 400 : error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : 409 : 503;
        writeJson(response, status, { error: error instanceof ReviewError ? `REVIEW_${error.code}` : "REVIEW_UNAVAILABLE" });
      }
    },
  };
}
