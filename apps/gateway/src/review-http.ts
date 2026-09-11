import { publicComment, publicReply, publicEvent, publicNotification } from "./review-contract.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { reviewDraftSession } from "./review-draft-session.ts";

import {
  ReviewError,
  normalizeRoutePath,
  type ReviewActor,
  type ReviewEvent,
  type ReviewService,
  type ReviewThreadStatus,
} from "../../../packages/review/src/index.ts";
import {
  canAccessSharedContent,
  type Principal,
} from "../../../packages/auth/src/index.ts";
import { createKeyedConcurrentAdmission } from "./keyed-concurrent-admission.ts";
import { REVIEW_BOOTSTRAP_SOURCE } from "./review-bootstrap.ts";

const REVIEW_PREFIX = "/_review-tunnel/review";
const CLIENT_BINDING_PREFIX = "/api/client/review-bindings/";
const MAX_CONTROL_FORM_BYTES = 4 * 1_024;
// Includes UTF-8 text, JSON escaping, the route and optional element anchor.
const MAX_REVIEW_JSON_BYTES = 64 * 1_024;

export type ReviewEventStreamPolicy = Readonly<{
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retryMs?: number;
  maxConnections?: number;
  maxConnectionsPerAccount?: number;
}>;

export const DEFAULT_REVIEW_EVENT_STREAM_POLICY: Required<ReviewEventStreamPolicy> = Object.freeze({
  pollIntervalMs: 500,
  heartbeatIntervalMs: 15_000,
  retryMs: 1_000,
  maxConnections: 128,
  maxConnectionsPerAccount: 4,
});

export function createReviewEventAdmission(input: Readonly<{
  maxConnections: number;
  maxConnectionsPerAccount: number;
}>) {
  const admission = createKeyedConcurrentAdmission({
    global: input.maxConnections,
    perKey: input.maxConnectionsPerAccount,
  });
  return {
    tryAcquire(accountId: string): (() => void) | undefined {
      return admission.acquire(accountId);
    },
  };
}

export type ReviewTunnelTarget = Readonly<{
  tunnelId: string;
  sessionId: string;
  ownerAccountId: string;
  publicOrigin: string;
  active: boolean;
  expiresAt: Date;
}>;

export function createReviewHttpHandler(input: Readonly<{
  service: ReviewService;
  resolveTunnel(tunnelId: string): ReviewTunnelTarget | undefined;
  controlOrigin?(tunnel: ReviewTunnelTarget): string;
  reportFailure?: (operation: "control" | "content" | "cleanup") => void;
  eventStreamPolicy?: ReviewEventStreamPolicy;
}>) {
  const eventStreamPolicy = {
    ...DEFAULT_REVIEW_EVENT_STREAM_POLICY,
    ...input.eventStreamPolicy,
  };
  for (const [name, value] of Object.entries(eventStreamPolicy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  const eventSubscriptions = new Set<ReviewEventSubscription>();
  const workingTrees = new Map<string, { state: "clean" | "modified" | "unknown"; reportedAt: string }>();
  const bindingKey = (tunnel: { tunnelId: string; sessionId: string }) => JSON.stringify([tunnel.tunnelId, tunnel.sessionId]);
  const eventAdmission = createReviewEventAdmission(eventStreamPolicy);

  const closeEventSubscription = (
    subscription: ReviewEventSubscription,
    destroy = false,
  ): void => {
    if (subscription.closed) return;
    subscription.closed = true;
    eventSubscriptions.delete(subscription);
    subscription.releaseAdmission();
    if (destroy) subscription.response.destroy();
    else if (!subscription.response.writableEnded) subscription.response.end();
  };
  const writeEventChunk = (
    subscription: ReviewEventSubscription,
    chunk: string,
  ): boolean => {
    if (subscription.closed || subscription.response.destroyed) return false;
    subscription.lastWriteAt = Date.now();
    if (subscription.response.write(chunk)) return true;
    closeEventSubscription(subscription, true);
    return false;
  };
  const writeEvents = (
    subscription: ReviewEventSubscription,
    events: readonly ReviewEvent[],
  ): void => {
    for (const event of events) {
      if (!writeEventChunk(
        subscription,
        `id: ${event.id}\nevent: review\ndata: ${JSON.stringify(publicEvent(event))}\n\n`,
      )) return;
      subscription.cursor = event.id;
    }
  };
  const pollEventSubscription = async (
    subscription: ReviewEventSubscription,
  ): Promise<void> => {
    if (subscription.closed || subscription.polling) return;
    subscription.polling = true;
    try {
      const events = await input.service.listEvents({
        actor: subscription.actor,
        tunnelId: subscription.tunnel.tunnelId,
        sessionId: subscription.tunnel.sessionId,
        routePath: subscription.routePath,
        afterId: subscription.cursor,
      });
      writeEvents(subscription, events);
      if (
        !subscription.closed &&
        Date.now() - subscription.lastWriteAt >= eventStreamPolicy.heartbeatIntervalMs
      ) writeEventChunk(subscription, `: heartbeat ${Date.now()}\n\n`);
    } catch (error) {
      if (error instanceof ReviewError) {
        writeEventChunk(subscription, `event: review-error\ndata: ${JSON.stringify({
          error: error.code === "CURSOR_EXPIRED" ? "REVIEW_CURSOR_EXPIRED"
            : error.code === "FORBIDDEN" ? "REVIEW_FORBIDDEN" : "REVIEW_NOT_FOUND",
        })}\n\n`);
      } else input.reportFailure?.("content");
      closeEventSubscription(subscription);
    } finally {
      subscription.polling = false;
    }
  };
  const eventPollTimer = setInterval(() => {
    for (const subscription of eventSubscriptions) {
      void pollEventSubscription(subscription);
    }
  }, eventStreamPolicy.pollIntervalMs);
  eventPollTimer.unref();

  const openEventStream = async (stream: Readonly<{
    request: IncomingMessage;
    response: ServerResponse;
    actor: ReviewActor;
    tunnel: ReviewTunnelTarget;
    routePath: string;
    afterId?: string;
  }>): Promise<void> => {
    const releaseAdmission = eventAdmission.tryAcquire(stream.actor.accountId);
    if (releaseAdmission === undefined) {
      writeJsonError(stream.response, 429, "REVIEW_STREAM_LIMIT");
      return;
    }
    let retainedBySubscription = false;
    try {
      let initialEvents: readonly ReviewEvent[];
      let cursorExpired = false;
      try {
        initialEvents = await input.service.listEvents({
          actor: stream.actor,
          tunnelId: stream.tunnel.tunnelId,
          sessionId: stream.tunnel.sessionId,
          routePath: stream.routePath,
          ...(stream.afterId === undefined ? {} : { afterId: stream.afterId }),
        });
      } catch (error) {
        if (!(error instanceof ReviewError) || error.code !== "CURSOR_EXPIRED") throw error;
        initialEvents = [];
        cursorExpired = true;
      }
      if (stream.request.destroyed || stream.response.destroyed) return;
      stream.response.statusCode = 200;
      stream.response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      stream.response.setHeader("Connection", "keep-alive");
      stream.response.setHeader("X-Accel-Buffering", "no");
      stream.response.flushHeaders();
      const subscription: ReviewEventSubscription = {
        actor: stream.actor,
        tunnel: stream.tunnel,
        routePath: stream.routePath,
        cursor: stream.afterId ?? "0",
        response: stream.response,
        closed: false,
        polling: false,
        lastWriteAt: Date.now(),
        releaseAdmission,
      };
      const close = () => closeEventSubscription(subscription);
      stream.request.once("aborted", close);
      stream.response.once("close", close);
      eventSubscriptions.add(subscription);
      retainedBySubscription = true;
      if (!writeEventChunk(subscription, `retry: ${eventStreamPolicy.retryMs}\n\n`)) return;
      if (cursorExpired) {
        writeEventChunk(subscription, `event: review-error\ndata: ${JSON.stringify({ error: "REVIEW_CURSOR_EXPIRED" })}\n\n`);
        closeEventSubscription(subscription);
        return;
      }
      writeEvents(subscription, initialEvents);
    } finally {
      if (!retainedBySubscription) releaseAdmission();
    }
  };
  const handleFailure = (
    response: ServerResponse,
    error: unknown,
    operation: "control" | "content",
  ): void => {
    if (response.writableEnded || response.destroyed) return;
    if (error instanceof ReviewError) {
      const mapping = error.code === "INVALID_INPUT"
        ? { status: 400, code: "INVALID_REVIEW_INPUT" }
        : error.code === "FORBIDDEN"
        ? { status: 403, code: "REVIEW_FORBIDDEN" }
        : error.code === "NOT_FOUND"
        ? { status: 404, code: "REVIEW_NOT_FOUND" }
        : error.code === "STATE_CONFLICT"
        ? { status: 409, code: "REVIEW_STATE_CONFLICT" }
        : error.code === "VERSION_CONFLICT"
        ? { status: 409, code: "REVIEW_VERSION_CONFLICT" }
        : error.code === "CURSOR_EXPIRED"
        ? { status: 409, code: "REVIEW_CURSOR_EXPIRED" }
        : error.code === "REVIEWER_UNAVAILABLE"
        ? { status: 409, code: "REVIEW_REVIEWER_UNAVAILABLE" }
        : { status: 409, code: "REVIEW_BINDING_CONFLICT" };
      writeJsonError(response, mapping.status, mapping.code);
      return;
    }
    input.reportFailure?.(operation);
    writeJsonError(response, 503, "REVIEW_UNAVAILABLE");
  };

  return {
    clientControlExtension: {
      matches(_method: string, pathname: string): boolean {
        return pathname.startsWith(CLIENT_BINDING_PREFIX);
      },
      async handle(extension: Readonly<{
        request: IncomingMessage;
        response: ServerResponse;
        principal: Principal;
      }>): Promise<void> {
        try {
          if (extension.request.method !== "PUT") {
            extension.response.setHeader("Allow", "PUT");
            writeJsonError(extension.response, 405, "METHOD_NOT_ALLOWED");
            return;
          }
          const pathname = new URL(
            extension.request.url ?? "/",
            "http://control.invalid",
          ).pathname;
          const tunnelId = decodePathSegment(pathname.slice(CLIENT_BINDING_PREFIX.length));
          const tunnel = input.resolveTunnel(tunnelId);
          if (tunnel === undefined || !tunnel.active) {
            throw new ReviewError("NOT_FOUND", "active Tunnel was not found");
          }
          const form = await readForm(extension.request, MAX_CONTROL_FORM_BYTES);
          requireExactFormFields(form, ["projectSlug", "revisionKey", ...(form.has("workingTree") ? ["workingTree"] : [])]);
          const workingTree = form.get("workingTree") ?? "unknown";
          if (workingTree !== "clean" && workingTree !== "modified" && workingTree !== "unknown") throw new ReviewError("INVALID_INPUT", "workingTree is invalid");
          const context = await input.service.bindTunnel({
            actor: reviewActorFromPrincipal(extension.principal),
            tunnelOwnerAccountId: tunnel.ownerAccountId,
            tunnelId: tunnel.tunnelId,
            sessionId: tunnel.sessionId,
            expiresAt: tunnel.expiresAt,
            projectSlug: requiredFormValue(form, "projectSlug"),
            revisionKey: requiredFormValue(form, "revisionKey"),
          });
          const currentTunnel = input.resolveTunnel(tunnel.tunnelId);
          if (!currentTunnel?.active || currentTunnel.sessionId !== tunnel.sessionId) throw new ReviewError("NOT_FOUND", "Tunnel closed during binding");
          workingTrees.set(bindingKey(tunnel), { state: workingTree, reportedAt: new Date().toISOString() });
          writeJson(extension.response, 200, {
            project: {
              slug: context.project.slug,
              displayName: context.project.displayName,
            },
            revision: { key: context.revision.key },
          });
        } catch (error) {
          handleFailure(extension.response, error, "control");
        }
      },
    },

    matchesContentPath(pathname: string): boolean {
      return pathname === REVIEW_PREFIX || pathname.startsWith(`${REVIEW_PREFIX}/`);
    },

    async handleContent(extension: Readonly<{
      request: IncomingMessage;
      response: ServerResponse;
      principal: Principal;
      tunnel: ReviewTunnelTarget;
    }>): Promise<void> {
      const { request, response, tunnel } = extension;
      applyReviewHeaders(response);
      try {
        if (!tunnel.active) throw new ReviewError("NOT_FOUND", "active Tunnel was not found");
        const url = new URL(request.url ?? "/", tunnel.publicOrigin);
        const actor = reviewActorFromPrincipal(extension.principal);
        if (request.method === "GET" && url.pathname === `${REVIEW_PREFIX}/bootstrap.js`) {
          await input.service.getContext({
            actor,
            tunnelId: tunnel.tunnelId,
            sessionId: tunnel.sessionId,
          });
          writeJavaScript(response, REVIEW_BOOTSTRAP_SOURCE);
          return;
        }
        if (request.method === "GET" && url.pathname === `${REVIEW_PREFIX}/context`) {
          writeJson(response, 200, { ...await input.service.getContext({
            actor,
            tunnelId: tunnel.tunnelId,
            sessionId: tunnel.sessionId,
          }), controlOrigin: input.controlOrigin?.(tunnel), draftSession: reviewDraftSession(extension.principal), workingTree: workingTrees.get(bindingKey(tunnel)) });
          return;
        }
        if (request.method === "GET" && url.pathname === `${REVIEW_PREFIX}/mentions`) {
          writeJson(response, 200, { candidates: await input.service.listMentionCandidates({ actor, tunnelId: tunnel.tunnelId, sessionId: tunnel.sessionId, prefix: url.searchParams.get("prefix") ?? "" }) });
          return;
        }
        if (request.method === "GET" && url.pathname === `${REVIEW_PREFIX}/focus`) {
          const comment = await input.service.getThread({ actor, tunnelId: tunnel.tunnelId, sessionId: tunnel.sessionId, commentId: url.searchParams.get("thread") ?? "" });
          const path = normalizeRoutePath(comment.routePath);
          if (new URL(path, tunnel.publicOrigin).origin !== new URL(tunnel.publicOrigin).origin) {
            throw new ReviewError("INVALID_INPUT", "review focus must stay on the shared app origin");
          }
          const nonce = randomBytes(18).toString("base64");
          const focus = JSON.stringify({ id: comment.id, path, revisionId: comment.revisionId, expiresAt: Date.now() + 60_000 }).replaceAll("<", "\\u003c");
          response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(`<!doctype html><meta charset="utf-8"><title>리뷰로 이동</title><p>리뷰가 있는 페이지로 이동합니다.</p><script nonce="${nonce}">const focus=${focus};try{sessionStorage.setItem('review-tunnel:focus',JSON.stringify(focus));}catch{}location.replace(focus.path);</script>`);
          return;
        }
        if (url.pathname === `${REVIEW_PREFIX}/events`) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
            return;
          }
          requireOptionalExactOrigin(request, tunnel.publicOrigin);
          const paths = url.searchParams.getAll("path");
          const afterIds = url.searchParams.getAll("after");
          if (
            paths.length !== 1 ||
            afterIds.length > 1 ||
            [...url.searchParams.keys()].some((key) => key !== "path" && key !== "after")
          ) {
            throw new ReviewError("INVALID_INPUT", "one page path is required");
          }
          const lastEventId = request.headers["last-event-id"];
          if (Array.isArray(lastEventId)) {
            throw new ReviewError("INVALID_INPUT", "review event cursor is invalid");
          }
          await openEventStream({
            request,
            response,
            actor,
            tunnel,
            routePath: paths[0]!,
            ...(lastEventId !== undefined
              ? { afterId: lastEventId }
              : afterIds[0] === undefined
              ? {}
              : { afterId: afterIds[0] }),
          });
          return;
        }
        if (url.pathname === `${REVIEW_PREFIX}/notifications`) {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
            return;
          }
          const paths = url.searchParams.getAll("path");
          if (paths.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "path")) {
            throw new ReviewError("INVALID_INPUT", "one page path is required");
          }
          const notifications = await input.service.listNotifications({
            actor,
            tunnelId: tunnel.tunnelId,
            sessionId: tunnel.sessionId,
            routePath: paths[0]!,
          });
          writeJson(response, 200, {
            notifications: notifications.map(publicNotification),
          });
          return;
        }
        const notificationId = matchNotificationPath(url.pathname);
        if (notificationId !== undefined) {
          if (request.method !== "PATCH") {
            response.setHeader("Allow", "PATCH");
            writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
            return;
          }
          requireExactOrigin(request, tunnel.publicOrigin);
          requireNoSearchParameters(url);
          const command = await readJsonObject(request, MAX_REVIEW_JSON_BYTES);
          requireExactObjectKeys(command, ["path", "read"]);
          const notification = await input.service.setNotificationRead({
            actor,
            tunnelId: tunnel.tunnelId,
            sessionId: tunnel.sessionId,
            notificationId,
            routePath: requiredString(command, "path"),
            read: requiredBoolean(command, "read"),
          });
          writeJson(response, 200, { notification: publicNotification(notification) });
          return;
        }
        if (url.pathname === `${REVIEW_PREFIX}/comments`) {
          if (request.method === "GET") {
            const query = pageQuery(url, true);
            const page = await input.service.listPageCommentPage({
              actor,
              tunnelId: tunnel.tunnelId,
              sessionId: tunnel.sessionId,
              routePath: query.path,
              ...(query.status === undefined ? {} : { status: query.status }),
              ...(query.author === undefined ? {} : { author: query.author }),
              ...(query.before === undefined ? {} : { before: query.before }),
            });
            writeJson(response, 200, {
              comments: page.comments.map((comment) => publicComment(comment, actor)),
              openCount: page.openCount,
              filteredCount: page.filteredCount,
              eventCursor: page.eventCursor,
              pageInfo: page.pageInfo,
            });
            return;
          }
          if (request.method === "POST") {
            requireExactOrigin(request, tunnel.publicOrigin);
            requireNoSearchParameters(url);
            const command = await readJsonObject(request, MAX_REVIEW_JSON_BYTES);
            const hasAnchor = Object.hasOwn(command, "anchor");
            requireExactObjectKeys(command, hasAnchor
              ? ["path", "body", "anchor"]
              : ["path", "body"]);
            const base = {
              actor,
              tunnelId: tunnel.tunnelId,
              sessionId: tunnel.sessionId,
              routePath: requiredString(command, "path"),
              body: requiredString(command, "body"),
            };
            const comment = hasAnchor
              ? await input.service.createRegionComment({ ...base, anchor: command.anchor })
              : await input.service.createPageComment(base);
            writeJson(response, 201, { comment: publicComment(comment, actor) });
            return;
          }
          response.setHeader("Allow", "GET, POST");
          writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
          return;
        }
        const commentAction = matchCommentAction(url.pathname);
        if (commentAction !== undefined) {
          if (commentAction.action === "comment") {
            if (request.method === "GET") {
              const query = pageQuery(url);
              const comment = await input.service.getThread({ actor, tunnelId: tunnel.tunnelId, sessionId: tunnel.sessionId, commentId: commentAction.commentId, routePath: query.path });
              writeJson(response, 200, { comment: publicComment(comment, actor) });
              return;
            }
            requireNoSearchParameters(url);
            if (request.method !== "PATCH" && request.method !== "DELETE") {
              response.setHeader("Allow", "PATCH, DELETE");
              writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
              return;
            }
            requireExactOrigin(request, tunnel.publicOrigin);
            const command = await readJsonObject(request, MAX_REVIEW_JSON_BYTES);
            requireExactObjectKeys(command, request.method === "PATCH"
              ? ["path", "expectedVersion", "body"]
              : ["path", "expectedVersion"]);
            const base = {
              actor,
              tunnelId: tunnel.tunnelId,
              sessionId: tunnel.sessionId,
              commentId: commentAction.commentId,
              routePath: requiredString(command, "path"),
              expectedVersion: requiredContentVersion(command, "expectedVersion"),
            };
            const comment = request.method === "PATCH"
              ? await input.service.updateComment({
                  ...base,
                  body: requiredString(command, "body"),
                })
              : await input.service.deleteComment(base);
            writeJson(response, 200, { comment: publicComment(comment, actor) });
            return;
          }
          if (commentAction.action === "reply") {
            requireNoSearchParameters(url);
            if (request.method !== "PATCH" && request.method !== "DELETE") {
              response.setHeader("Allow", "PATCH, DELETE");
              writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
              return;
            }
            requireExactOrigin(request, tunnel.publicOrigin);
            const command = await readJsonObject(request, MAX_REVIEW_JSON_BYTES);
            requireExactObjectKeys(command, request.method === "PATCH"
              ? ["path", "expectedVersion", "body"]
              : ["path", "expectedVersion"]);
            const base = {
              actor,
              tunnelId: tunnel.tunnelId,
              sessionId: tunnel.sessionId,
              commentId: commentAction.commentId,
              replyId: commentAction.replyId,
              routePath: requiredString(command, "path"),
              expectedVersion: requiredContentVersion(command, "expectedVersion"),
            };
            const reply = request.method === "PATCH"
              ? await input.service.updateReply({
                  ...base,
                  body: requiredString(command, "body"),
                })
              : await input.service.deleteReply(base);
            writeJson(response, 200, { reply: publicReply(reply, actor, "OPEN") });
            return;
          }
          if (commentAction.action === "replies") {
            if (request.method === "GET") {
              const query = pageQuery(url);
              const page = await input.service.listReplyPage({
                actor,
                tunnelId: tunnel.tunnelId,
                sessionId: tunnel.sessionId,
                commentId: commentAction.commentId,
                routePath: query.path,
                ...(query.before === undefined ? {} : { before: query.before }),
              });
              writeJson(response, 200, {
                replies: page.replies.map((reply) => publicReply(reply, actor, page.threadStatus)),
                pageInfo: page.pageInfo,
              });
              return;
            }
            if (request.method !== "POST") {
              response.setHeader("Allow", "GET, POST");
              writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
              return;
            }
            requireNoSearchParameters(url);
            requireExactOrigin(request, tunnel.publicOrigin);
            const command = await readJsonObject(request, MAX_REVIEW_JSON_BYTES);
            requireExactObjectKeys(command, ["path", "body"]);
            const reply = await input.service.createReply({
              actor,
              tunnelId: tunnel.tunnelId,
              sessionId: tunnel.sessionId,
              commentId: commentAction.commentId,
              routePath: requiredString(command, "path"),
              body: requiredString(command, "body"),
            });
            writeJson(response, 201, { reply: publicReply(reply, actor, "OPEN") });
            return;
          }
          requireNoSearchParameters(url);
          if (request.method !== "PATCH") {
            response.setHeader("Allow", "PATCH");
            writeJsonError(response, 405, "METHOD_NOT_ALLOWED");
            return;
          }
          requireExactOrigin(request, tunnel.publicOrigin);
          const command = await readJsonObject(request, MAX_REVIEW_JSON_BYTES);
          requireExactObjectKeys(command, Object.hasOwn(command, "expectedWorkflowVersion") ? ["path", "expectedStatus", "status", "expectedWorkflowVersion"] : ["path", "expectedStatus", "status"]);
          const comment = await input.service.changePageCommentStatus({
            actor,
            tunnelId: tunnel.tunnelId,
            sessionId: tunnel.sessionId,
            commentId: commentAction.commentId,
            routePath: requiredString(command, "path"),
            expectedStatus: requiredThreadStatus(command, "expectedStatus"),
            expectedWorkflowVersion: command.expectedWorkflowVersion === undefined ? 1 : requiredContentVersion(command, "expectedWorkflowVersion"),
            status: requiredThreadStatus(command, "status"),
          });
          writeJson(response, 200, { comment: publicComment(comment, actor) });
          return;
        }
        writeJsonError(response, 404, "REVIEW_NOT_FOUND");
      } catch (error) {
        handleFailure(response, error, "content");
      }
    },

    async disposeBinding(tunnel: Readonly<{ tunnelId: string; sessionId: string }>): Promise<void> {
      workingTrees.delete(bindingKey(tunnel));
      for (const subscription of eventSubscriptions) {
        if (
          subscription.tunnel.tunnelId === tunnel.tunnelId &&
          subscription.tunnel.sessionId === tunnel.sessionId
        ) closeEventSubscription(subscription);
      }
      try {
        await input.service.removeTunnelBinding(tunnel);
      } catch {
        input.reportFailure?.("cleanup");
      }
    },

    close(): void {
      workingTrees.clear();
      clearInterval(eventPollTimer);
      for (const subscription of eventSubscriptions) closeEventSubscription(subscription);
    },
  };
}

type ReviewEventSubscription = {
  actor: ReviewActor;
  tunnel: ReviewTunnelTarget;
  routePath: string;
  cursor: string;
  response: ServerResponse;
  closed: boolean;
  polling: boolean;
  lastWriteAt: number;
  releaseAdmission: () => void;
};

export function reviewActorFromPrincipal(principal: Principal): ReviewActor {
  const canRead = canAccessSharedContent(principal.roles);
  return {
    accountId: principal.accountId,
    username: principal.username,
    authorizationVersion: principal.authVersion,
    displayName: principal.displayName,
    capabilities: {
      canRead,
      canComment: canRead,
      canManageProject: principal.roles.includes("DEVELOPER"),
    },
  };
}

function matchNotificationPath(pathname: string): string | undefined {
  const match = /^\/_review-tunnel\/review\/notifications\/([^/]+)$/.exec(pathname);
  return match === null ? undefined : decodePathSegment(match[1]!);
}

function matchCommentAction(pathname: string):
  | Readonly<{ commentId: string; action: "comment" | "replies" | "status" }>
  | Readonly<{ commentId: string; action: "reply"; replyId: string }>
  | undefined {
  const replyMatch = /^\/_review-tunnel\/review\/comments\/([^/]+)\/replies\/([^/]+)$/.exec(pathname);
  if (replyMatch !== null) return {
    commentId: decodePathSegment(replyMatch[1]!),
    action: "reply",
    replyId: decodePathSegment(replyMatch[2]!),
  };
  const actionMatch = /^\/_review-tunnel\/review\/comments\/([^/]+)\/(replies|status)$/.exec(pathname);
  if (actionMatch !== null) return {
    commentId: decodePathSegment(actionMatch[1]!),
    action: actionMatch[2] as "replies" | "status",
  };
  const commentMatch = /^\/_review-tunnel\/review\/comments\/([^/]+)$/.exec(pathname);
  if (commentMatch === null) return undefined;
  return {
    commentId: decodePathSegment(commentMatch[1]!),
    action: "comment",
  };
}

function decodePathSegment(value: string): string {
  if (value.length === 0 || value.includes("/")) {
    throw new ReviewError("INVALID_INPUT", "Tunnel id is invalid");
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ReviewError("INVALID_INPUT", "Tunnel id is invalid");
  }
}

async function readForm(request: IncomingMessage, maxBytes: number): Promise<URLSearchParams> {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
    throw new ReviewError("INVALID_INPUT", "unsupported control request format");
  }
  return new URLSearchParams((await readBody(request, maxBytes)).toString("utf8"));
}

export async function readJsonObject(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
    throw new ReviewError("INVALID_INPUT", "unsupported review request format");
  }
  let value: unknown;
  try {
    value = JSON.parse((await readBody(request, maxBytes)).toString("utf8"));
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError("INVALID_INPUT", "review JSON is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewError("INVALID_INPUT", "review JSON object is required");
  }
  return value as Record<string, unknown>;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new ReviewError("INVALID_INPUT", "review request is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function requireExactFormFields(form: URLSearchParams, expected: readonly string[]): void {
  const keys = [...form.keys()];
  if (
    keys.length !== expected.length ||
    expected.some((key) => form.getAll(key).length !== 1) ||
    keys.some((key) => !expected.includes(key))
  ) throw new ReviewError("INVALID_INPUT", "review binding fields are invalid");
}

function requiredFormValue(form: URLSearchParams, name: string): string {
  const value = form.get(name);
  if (value === null || value.length === 0) {
    throw new ReviewError("INVALID_INPUT", `${name} is required`);
  }
  return value;
}

export function requireExactObjectKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) throw new ReviewError("INVALID_INPUT", "review comment fields are invalid");
}

export function requiredString(value: Readonly<Record<string, unknown>>, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new ReviewError("INVALID_INPUT", `${name} is required`);
  return field;
}

export function requiredBoolean(value: Readonly<Record<string, unknown>>, name: string): boolean {
  const field = value[name];
  if (typeof field !== "boolean") throw new ReviewError("INVALID_INPUT", `${name} is required`);
  return field;
}

export function requiredThreadStatus(
  value: Readonly<Record<string, unknown>>,
  name: string,
): ReviewThreadStatus {
  const field = value[name];
  if (field !== "OPEN" && field !== "NEEDS_REVIEW" && field !== "RESOLVED") {
    throw new ReviewError("INVALID_INPUT", `${name} is invalid`);
  }
  return field;
}

export function requiredContentVersion(
  value: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const field = value[name];
  if (typeof field !== "number") {
    throw new ReviewError("INVALID_INPUT", `${name} is invalid`);
  }
  return field;
}

function requireNoSearchParameters(url: URL): void {
  if (url.search !== "") {
    throw new ReviewError("INVALID_INPUT", "review mutation query is invalid");
  }
}

function pageQuery(url: URL, filters = false): Readonly<{
  path: string; before?: string; status?: "OPEN" | "RESOLVED" | "ALL"; author?: "me";
}> {
  const paths = url.searchParams.getAll("path");
  const cursors = url.searchParams.getAll("before");
  const statuses = url.searchParams.getAll("status");
  const authors = url.searchParams.getAll("author");
  const allowed = filters ? ["path", "before", "status", "author"] : ["path", "before"];
  if (paths.length !== 1 || cursors.length > 1 || cursors[0] === "" ||
      statuses.length > 1 || authors.length > 1 ||
      [...url.searchParams.keys()].some(key => !allowed.includes(key)) ||
      (statuses[0] !== undefined && !["OPEN", "RESOLVED", "ALL"].includes(statuses[0])) ||
      (authors[0] !== undefined && authors[0] !== "me")) {
    throw new ReviewError("INVALID_INPUT", "review page query is invalid");
  }
  return {
    path: paths[0]!,
    ...(cursors[0] === undefined ? {} : { before: cursors[0] }),
    ...(statuses[0] === undefined ? {} : { status: statuses[0] as "OPEN" | "RESOLVED" | "ALL" }),
    ...(authors[0] === undefined ? {} : { author: "me" as const }),
  };
}

function requireExactOrigin(request: IncomingMessage, publicOrigin: string): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin !== new URL(publicOrigin).origin) {
    throw new ReviewError("FORBIDDEN", "review mutation origin is not allowed");
  }
}

function requireOptionalExactOrigin(request: IncomingMessage, publicOrigin: string): void {
  const origin = request.headers.origin;
  if (origin !== undefined && (typeof origin !== "string" || origin !== new URL(publicOrigin).origin)) {
    throw new ReviewError("FORBIDDEN", "review event origin is not allowed");
  }
}

function applyReviewHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function writeJavaScript(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function writeJsonError(response: ServerResponse, status: number, code: string): void {
  applyReviewHeaders(response);
  writeJson(response, status, { error: code });
}
