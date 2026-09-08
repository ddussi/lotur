import { checkContentMutation } from "../../review/src/content-mutation-policy.ts";
import type { Pool, QueryResultRow } from "pg";

import type {
  BindReviewTunnelInput,
  BindReviewTunnelResult,
  ChangePageCommentStatusResult,
  CreatePageCommentResult,
  CreateReviewReplyResult,
  ListReviewEventsResult,
  ListReviewNotificationsResult,
  MutateReviewCommentResult,
  MutateReviewReplyResult,
  PageCommentPage,
  PageCommentThread,
  ReviewBindingContext,
  ReviewIdentity,
  ReviewEvent,
  ReviewEventType,
  ReviewMentionContentType,
  ReviewNotification,
  ReviewProject,
  ReviewReply,
  ReviewReplyPage,
  ReviewRepository,
  ReviewRevision,
  ReviewThreadStatus,
  ReviewTunnelBinding,
  SetReviewNotificationReadResult,
} from "../../review/src/index.ts";
import {
  encodeReviewPageCursor,
  normalizePinNumber,
  normalizeRegionAnchor,
} from "../../review/src/index.ts";
import { REVIEW_SCHEMA_SQL } from "./review-schema.ts";
import { type Queryable, withTransaction } from "./postgres-transaction.ts";
import { withReviewEventTransaction } from "./review-event-transaction.ts";

class ReviewBindingConflict extends Error {}

export const DEFAULT_REVIEW_EVENT_RETENTION = Object.freeze({
  maxEvents: 100_000,
  maxAgeMs: 7 * 24 * 60 * 60_000,
});

export class PostgresReviewRepository implements ReviewRepository {
  readonly #database: Pool;
  readonly #maxEvents: number;
  readonly #maxEventAgeMs: number;

  constructor(database: Pool, options: Readonly<{
    maxEvents?: number;
    maxEventAgeMs?: number;
  }> = {}) {
    this.#database = database;
    this.#maxEvents = options.maxEvents ?? DEFAULT_REVIEW_EVENT_RETENTION.maxEvents;
    this.#maxEventAgeMs = options.maxEventAgeMs ?? DEFAULT_REVIEW_EVENT_RETENTION.maxAgeMs;
    if (!Number.isSafeInteger(this.#maxEvents) || this.#maxEvents <= 0) {
      throw new RangeError("maxEvents must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxEventAgeMs) || this.#maxEventAgeMs <= 0) {
      throw new RangeError("maxEventAgeMs must be a positive safe integer");
    }
  }

  async checkHealth(): Promise<void> {
    // Fail readiness before serving a UI that needs an unapplied migration.
    await this.#database.query("SELECT workflow_version FROM rt_review_threads LIMIT 1");
    await this.#database.query("SELECT reason, source_key, workflow_version FROM rt_review_notifications LIMIT 1");
    await this.#database.query("SELECT version FROM rt_review_workflow_history LIMIT 1");
    await this.#database.query("SELECT trimmed_through_id FROM rt_review_event_retention LIMIT 1");
  }

  async migrate(): Promise<void> {
    await withTransaction(this.#database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_467_289_112]);
      await client.query(REVIEW_SCHEMA_SQL);
    });
  }

  async listInbox(input: Parameters<ReviewRepository["listInbox"]>[0]) {
    const result = await this.#database.query<ReviewNotificationRow>(`${reviewNotificationSelect()}
      WHERE recipient_account_id = $1 AND ($2::bigint IS NULL OR notification.id < $2)
      AND (NOT $3::boolean OR read_at IS NULL) ORDER BY notification.id DESC LIMIT 51`, [input.actorAccountId, input.before ?? null, input.unreadOnly]);
    const count = await this.#database.query<{ count: string }>("SELECT count(*)::text AS count FROM rt_review_notifications WHERE recipient_account_id = $1 AND read_at IS NULL", [input.actorAccountId]);
    return { notifications: result.rows.slice(0, 50).map(toReviewNotification), unreadCount: Number(count.rows[0]?.count ?? 0),
      ...(result.rows.length > 50 ? { nextCursor: result.rows[49]!.id } : {}) };
  }
  async findNotificationForAccount(id: string, accountId: string) {
    const result = await this.#database.query<ReviewNotificationRow>(`${reviewNotificationSelect()} WHERE notification.id = $1::bigint AND recipient_account_id = $2`, [id, accountId]);
    return result.rows[0] === undefined ? undefined : toReviewNotification(result.rows[0]);
  }
  async listMentionCandidates(revisionId: string, prefix: string) {
    const result = await this.#database.query<{ username: string; display_name: string }>(`WITH participants(id) AS (
      SELECT project.owner_account_id FROM rt_review_projects project JOIN rt_review_revisions revision ON revision.project_id = project.id WHERE revision.id = $1
      UNION SELECT author_account_id FROM rt_review_threads WHERE revision_id = $1
      UNION SELECT reply.author_account_id FROM rt_review_replies reply JOIN rt_review_threads thread ON thread.id = reply.thread_id WHERE thread.revision_id = $1
    ) SELECT account.username, account.display_name FROM rt_accounts account JOIN participants ON participants.id = account.id
      WHERE account.enabled AND NOT account.must_change_password AND account.roles && ARRAY['DEVELOPER','REVIEWER']::text[]
      AND starts_with(account.username, $2) ORDER BY account.username LIMIT 20`, [revisionId, prefix]);
    return result.rows.map(item => ({ username: item.username, displayName: item.display_name }));
  }

  async listProjects() {
    const result = await this.#database.query<ReviewProjectRow & { open_count: string; last_activity_at: Date }>(
      `SELECT project.*, count(thread.id) FILTER (WHERE thread.status <> 'RESOLVED' AND thread.deleted_at IS NULL)::text AS open_count,
         GREATEST(project.created_at, max(thread.updated_at)) AS last_activity_at
       FROM rt_review_projects project LEFT JOIN rt_review_revisions revision ON revision.project_id = project.id
       LEFT JOIN rt_review_threads thread ON thread.revision_id = revision.id
       GROUP BY project.id ORDER BY last_activity_at DESC, project.id`,
    );
    return result.rows.map(row => ({ ...toProject(row), openCount: Number(row.open_count), lastActivityAt: row.last_activity_at }));
  }

  async listRevisions(projectId: string) {
    const result = await this.#database.query<ReviewRevisionRow & { open_count: string }>(
      `SELECT revision.*, count(thread.id) FILTER (WHERE thread.status <> 'RESOLVED' AND thread.deleted_at IS NULL)::text AS open_count
       FROM rt_review_revisions revision LEFT JOIN rt_review_threads thread ON thread.revision_id = revision.id
       WHERE revision.project_id = $1 GROUP BY revision.id ORDER BY revision.created_at DESC, revision.id DESC`, [projectId],
    );
    return result.rows.map(row => ({ ...toRevision(row), openCount: Number(row.open_count) }));
  }

  async findRevisionContext(projectId: string | undefined, revisionId: string) {
    const revisions = await this.#database.query<ReviewRevisionRow>(
      "SELECT * FROM rt_review_revisions WHERE id = $1 AND ($2::text IS NULL OR project_id = $2)", [revisionId, projectId ?? null],
    );
    const row = revisions.rows[0];
    if (row === undefined) return undefined;
    const projects = await this.#database.query<ReviewProjectRow>("SELECT * FROM rt_review_projects WHERE id = $1", [row.project_id]);
    return projects.rows[0] === undefined ? undefined : { project: toProject(projects.rows[0]), revision: toRevision(row) };
  }

  async findThread(threadId: string) {
    const thread = await findPageCommentThreadById(this.#database, threadId, 100);
    if (thread === undefined) return undefined;
    const page = await this.listReplyPage({ revisionId: thread.revisionId, routePath: thread.routePath, threadId, limit: 100 });
    return { ...thread, replies: page?.replies ?? [], replyPageInfo: page?.pageInfo ?? { hasMore: false } };
  }

  async bindTunnel(input: BindReviewTunnelInput): Promise<BindReviewTunnelResult> {
    try {
      return await withTransaction(this.#database, async (client) => {
        if (!await lockCurrentAccount(
          client,
          input.project.ownerAccountId,
          input.actorAuthorizationVersion,
        )) return { status: "STALE_AUTHORIZATION" } as const;

        await client.query(
          "DELETE FROM rt_review_tunnel_bindings WHERE expires_at <= $1",
          [input.binding.createdAt],
        );

        const collision = await findBindingCollision(
          client,
          input.binding.tunnelId,
          input.binding.sessionId,
        );
        if (collision !== undefined) {
          if (
            collision.binding.tunnelId === input.binding.tunnelId &&
            collision.binding.sessionId === input.binding.sessionId &&
            collision.binding.ownerAccountId === input.binding.ownerAccountId &&
            collision.project.ownerAccountId === input.project.ownerAccountId &&
            collision.project.slug === input.project.slug &&
            collision.revision.key === input.revision.key
          ) return { status: "BOUND", context: collision } as const;
          throw new ReviewBindingConflict();
        }

        const projectResult = await client.query<ReviewProjectRow>(
          `INSERT INTO rt_review_projects
           (id, owner_account_id, slug, display_name, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (owner_account_id, slug) DO UPDATE
           SET slug = EXCLUDED.slug
           RETURNING *`,
          [
            input.project.id,
            input.project.ownerAccountId,
            input.project.slug,
            input.project.displayName,
            input.project.createdAt,
          ],
        );
        const project = toProject(projectResult.rows[0]!);
        const revisionResult = await client.query<ReviewRevisionRow>(
          `INSERT INTO rt_review_revisions
           (id, project_id, revision_key, created_by_account_id, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, revision_key) DO UPDATE
           SET revision_key = EXCLUDED.revision_key
           RETURNING *`,
          [
            input.revision.id,
            project.id,
            input.revision.key,
            input.revision.createdByAccountId,
            input.revision.createdAt,
          ],
        );
        const revision = toRevision(revisionResult.rows[0]!);
        const bindingResult = await client.query<ReviewTunnelBindingRow>(
          `INSERT INTO rt_review_tunnel_bindings
           (tunnel_id, session_id, revision_id, owner_account_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            input.binding.tunnelId,
            input.binding.sessionId,
            revision.id,
            input.binding.ownerAccountId,
            input.binding.createdAt,
            input.binding.expiresAt,
          ],
        );
        const inserted = bindingResult.rows[0];
        if (inserted !== undefined) {
          return {
            status: "BOUND",
            context: { project, revision, binding: toBinding(inserted) },
          } as const;
        }
        const concurrent = await findBindingCollision(
          client,
          input.binding.tunnelId,
          input.binding.sessionId,
        );
        if (
          concurrent !== undefined &&
          concurrent.binding.tunnelId === input.binding.tunnelId &&
          concurrent.binding.sessionId === input.binding.sessionId &&
          concurrent.binding.ownerAccountId === input.binding.ownerAccountId &&
          concurrent.project.id === project.id &&
          concurrent.revision.id === revision.id
        ) return { status: "BOUND", context: concurrent } as const;
        throw new ReviewBindingConflict();
      });
    } catch (error) {
      if (error instanceof ReviewBindingConflict) return { status: "CONFLICT" };
      throw error;
    }
  }

  findBindingContext(input: Readonly<{
    tunnelId: string;
    sessionId: string;
  }>): Promise<ReviewBindingContext | undefined> {
    return findBindingContext(this.#database, input.tunnelId, input.sessionId);
  }

  async removeTunnelBinding(input: Readonly<{
    tunnelId: string;
    sessionId: string;
  }>): Promise<void> {
    await this.#database.query(
      `DELETE FROM rt_review_tunnel_bindings
       WHERE tunnel_id = $1 AND session_id = $2`,
      [input.tunnelId, input.sessionId],
    );
  }

  async createPageComment(input: Parameters<ReviewRepository["createPageComment"]>[0]): Promise<CreatePageCommentResult> {
    return withReviewEventTransaction(this.#database, input.thread, async (client) => {
      if (!await lockCurrentAccount(
        client,
        input.thread.author.accountId,
        input.actorAuthorizationVersion,
      )) return { status: "STALE_AUTHORIZATION" } as const;
      if (!await checkReviewAccess(client, { ...input, revisionId: input.thread.revisionId })) {
        return { status: "BINDING_NOT_FOUND" } as const;
      }
      const pinNumber = input.thread.anchor.type === "REGION_V1"
        ? await allocateReviewPinNumber(
            client,
            input.thread.revisionId,
            input.thread.routePath,
          )
        : undefined;
      const storedThread: PageCommentThread = pinNumber === undefined
        ? input.thread
        : { ...input.thread, pinNumber };
      await client.query(
        `INSERT INTO rt_review_threads
         (id, revision_id, route_path, anchor_type, anchor, pin_number, status, body,
          author_account_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, $9, $10)`,
        [
          storedThread.id,
          storedThread.revisionId,
          storedThread.routePath,
          storedThread.anchor.type === "PAGE" ? "PAGE" : "REGION",
          storedThread.anchor.type === "PAGE" ? null : storedThread.anchor,
          pinNumber ?? null,
          storedThread.body,
          storedThread.author.accountId,
          storedThread.createdAt,
          storedThread.updatedAt,
        ],
      );
      await recordReviewEvent(client, {
        revisionId: input.thread.revisionId,
        routePath: input.thread.routePath,
        threadId: input.thread.id,
        type: "COMMENT_CREATED",
        actorAccountId: input.thread.author.accountId,
        occurredAt: input.thread.createdAt,
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      await syncReviewMentions(client, {
        revisionId: input.thread.revisionId,
        routePath: input.thread.routePath,
        threadId: input.thread.id,
        contentType: "COMMENT",
        contentId: input.thread.id,
        mentionUsernames: input.mentionUsernames,
        actorAccountId: input.thread.author.accountId,
        occurredAt: input.thread.createdAt,
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      return { status: "CREATED", thread: storedThread } as const;
    });
  }

  async createReply(input: Parameters<ReviewRepository["createReply"]>[0]): Promise<CreateReviewReplyResult> {
    return withReviewEventTransaction(this.#database, input, async (client) => {
      if (!await lockCurrentAccount(
        client,
        input.reply.author.accountId,
        input.actorAuthorizationVersion,
      )) return { status: "STALE_AUTHORIZATION" } as const;
      const currentStatus = await lockBoundThreadStatus(client, { ...input, threadId: input.reply.threadId });
      if (currentStatus === undefined) return { status: "THREAD_NOT_FOUND" } as const;
      if (currentStatus === "RESOLVED") return { status: "STATE_CONFLICT" } as const;
      await client.query(
        `INSERT INTO rt_review_replies
         (id, thread_id, body, author_account_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [
          input.reply.id,
          input.reply.threadId,
          input.reply.body,
          input.reply.author.accountId,
          input.reply.createdAt,
        ],
      );
      await client.query(
        `UPDATE rt_review_threads
         SET updated_at = $2
         WHERE id = $1`,
        [input.reply.threadId, input.reply.createdAt],
      );
      await recordReviewEvent(client, {
        revisionId: input.revisionId,
        routePath: input.routePath,
        threadId: input.reply.threadId,
        type: "REPLY_CREATED",
        actorAccountId: input.reply.author.accountId,
        occurredAt: input.reply.createdAt,
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      await syncReviewMentions(client, {
        revisionId: input.revisionId,
        routePath: input.routePath,
        threadId: input.reply.threadId,
        contentType: "REPLY",
        contentId: input.reply.id,
        mentionUsernames: input.mentionUsernames,
        actorAccountId: input.reply.author.accountId,
        occurredAt: input.reply.createdAt,
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      const notified = await client.query<{ recipient_account_id: string }>(`WITH participants(account_id) AS (
        SELECT author_account_id FROM rt_review_threads WHERE id = $6
        UNION SELECT author_account_id FROM rt_review_replies WHERE thread_id = $6
      ) INSERT INTO rt_review_notifications
        (revision_id, route_path, thread_id, content_type, content_id, recipient_account_id, actor_account_id, created_at, reason, source_key)
        SELECT $1, $2, $6, 'REPLY', $3, recipient.id, $4, $5, 'REPLY', 'reply:' || $3
        FROM participants JOIN rt_accounts recipient ON recipient.id = participants.account_id
        WHERE recipient.id <> $4 AND recipient.enabled AND NOT recipient.must_change_password
          AND recipient.roles && ARRAY['DEVELOPER','REVIEWER']::text[]
          AND NOT EXISTS (SELECT 1 FROM rt_review_notifications WHERE content_type = 'REPLY' AND content_id = $3 AND recipient_account_id = recipient.id)
        ON CONFLICT (recipient_account_id, source_key) DO NOTHING
        RETURNING recipient_account_id`, [input.revisionId, input.routePath, input.reply.id, input.reply.author.accountId, input.reply.createdAt, input.reply.threadId]);
      for (const row of notified.rows) await recordReviewEvent(client, { revisionId: input.revisionId, routePath: input.routePath, threadId: input.reply.threadId,
        type: "NOTIFICATION_CREATED", actorAccountId: input.reply.author.accountId, recipientAccountId: row.recipient_account_id,
        occurredAt: input.reply.createdAt, maxEvents: this.#maxEvents, maxEventAgeMs: this.#maxEventAgeMs });
      return { status: "CREATED", reply: input.reply } as const;
    });
  }

  async changePageCommentStatus(input: Parameters<ReviewRepository["changePageCommentStatus"]>[0]): Promise<ChangePageCommentStatusResult> {
    return withReviewEventTransaction(this.#database, input, async (client) => {
      if (!await lockCurrentAccount(
        client,
        input.actor.accountId,
        input.actorAuthorizationVersion,
      )) return { status: "STALE_AUTHORIZATION" } as const;
      const current = await lockBoundThreadContent(client, input);
      if (current === undefined) return { status: "THREAD_NOT_FOUND" } as const;
      if (current.status !== input.expectedStatus || current.workflow_version !== input.expectedWorkflowVersion || current.deleted_at !== null) return { status: "STATE_CONFLICT" } as const;
      if (!input.actorCanManageProject && !(current.author_account_id === input.actor.accountId && current.status === "NEEDS_REVIEW" && input.status !== "NEEDS_REVIEW")) return { status: "STALE_AUTHORIZATION" } as const;
      if (input.status === "NEEDS_REVIEW") {
        const recipient = await client.query(`SELECT id FROM rt_accounts WHERE id = $1 AND enabled AND NOT must_change_password AND roles && ARRAY['DEVELOPER','REVIEWER']::text[] FOR SHARE`, [current.author_account_id]);
        if (!recipient.rowCount) return { status: "REVIEWER_UNAVAILABLE" } as const;
      }
      await client.query(`INSERT INTO rt_review_workflow_history (thread_id, version, from_status, to_status, actor_account_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.threadId, current.workflow_version + 1, current.status, input.status, input.actor.accountId, input.changedAt]);
      await client.query(
        `UPDATE rt_review_threads
         SET status = $2::text,
             workflow_version = workflow_version + 1,
             resolved_by_account_id =
               CASE WHEN $2::text = 'RESOLVED' THEN $3::text ELSE NULL::text END,
             resolved_at =
               CASE WHEN $2::text = 'RESOLVED' THEN $4::timestamptz ELSE NULL::timestamptz END,
             updated_at = $4::timestamptz
         WHERE id = $1`,
        [input.threadId, input.status, input.actor.accountId, input.changedAt],
      );
      await recordReviewEvent(client, {
        revisionId: input.revisionId,
        routePath: input.routePath,
        threadId: input.threadId,
        type: "THREAD_STATUS_CHANGED",
        actorAccountId: input.actor.accountId,
        occurredAt: input.changedAt,
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      if (input.status === "NEEDS_REVIEW" || current.status === "NEEDS_REVIEW") {
        const previousRequest = input.status === "NEEDS_REVIEW" ? undefined : (await client.query<{ actor_account_id: string; version: number }>(
          "SELECT actor_account_id, version FROM rt_review_workflow_history WHERE thread_id = $1 AND to_status = 'NEEDS_REVIEW' ORDER BY version DESC LIMIT 1", [input.threadId])).rows[0];
        const recipientId = input.status === "NEEDS_REVIEW" ? current.author_account_id : previousRequest?.actor_account_id;
        const requestVersion = input.status === "NEEDS_REVIEW" ? current.workflow_version + 1 : previousRequest?.version;
        if (current.status === "NEEDS_REVIEW" && requestVersion !== undefined) {
          await client.query("UPDATE rt_review_notifications SET read_at = COALESCE(read_at, $4) WHERE thread_id = $1 AND recipient_account_id = $2 AND workflow_version = $3 AND reason = 'WORKFLOW_REQUEST'", [input.threadId, input.actor.accountId, requestVersion, input.changedAt]);
        }
        if (recipientId !== undefined && recipientId !== input.actor.accountId) {
          const notice = await client.query(`INSERT INTO rt_review_notifications (revision_id, route_path, thread_id, content_type, content_id, recipient_account_id, actor_account_id, created_at, reason, source_key, workflow_version)
            SELECT $1,$2,$3,'COMMENT',$3,recipient.id,$5,$6,$7,$8,$9 FROM rt_accounts recipient WHERE id = $4 AND enabled AND NOT must_change_password AND roles && ARRAY['DEVELOPER','REVIEWER']::text[]
            ON CONFLICT (recipient_account_id, source_key) DO NOTHING`, [input.revisionId, input.routePath, input.threadId, recipientId, input.actor.accountId, input.changedAt,
              input.status === "NEEDS_REVIEW" ? "WORKFLOW_REQUEST" : "WORKFLOW_RESULT", `workflow:${input.threadId}:${current.workflow_version + 1}`, requestVersion]);
          if (notice.rowCount) await recordReviewEvent(client, { revisionId: input.revisionId, routePath: input.routePath, threadId: input.threadId, type: "NOTIFICATION_CREATED",
            actorAccountId: input.actor.accountId, recipientAccountId: recipientId, occurredAt: input.changedAt, maxEvents: this.#maxEvents, maxEventAgeMs: this.#maxEventAgeMs });
        }
      }
      const thread = await findPageCommentThreadById(client, input.threadId, 100);
      if (thread === undefined) throw new Error("updated review thread disappeared");
      return { status: "UPDATED", thread } as const;
    });
  }

  async updateComment(
    input: Parameters<ReviewRepository["updateComment"]>[0],
  ): Promise<MutateReviewCommentResult> {
    return withReviewEventTransaction(this.#database, input, async (client) => {
      if (!await lockCurrentAccount(client, input.actor.accountId, input.actorAuthorizationVersion)) {
        return { status: "STALE_AUTHORIZATION" } as const;
      }
      const current = await lockBoundThreadContent(client, input);
      if (current === undefined) return { status: "THREAD_NOT_FOUND" } as const;
      const decision = checkContentMutation({
        action: "UPDATE", actorAccountId: input.actor.accountId,
        canManageProject: false,
        content: { authorAccountId: current.author_account_id, version: current.content_version, deleted: current.deleted_at !== null },
        thread: { status: current.status, deleted: current.deleted_at !== null },
        expectedVersion: input.expectedVersion,
      });
      if (decision !== "ALLOWED") return { status: decision };
      await client.query(
        `UPDATE rt_review_threads
         SET body = $2, content_version = content_version + 1, updated_at = $3
         WHERE id = $1`,
        [input.threadId, input.body, input.changedAt],
      );
      await this.#recordMutationEvent(client, input, "COMMENT_UPDATED");
      await syncReviewMentions(client, {
        ...mentionMutationInput(input, "COMMENT", input.threadId),
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      const thread = await findPageCommentThreadById(client, input.threadId, 100);
      if (thread === undefined) throw new Error("updated review thread disappeared");
      return { status: "UPDATED", thread } as const;
    });
  }

  async deleteComment(
    input: Parameters<ReviewRepository["deleteComment"]>[0],
  ): Promise<MutateReviewCommentResult> {
    return withReviewEventTransaction(this.#database, input, async (client) => {
      if (!await lockCurrentAccount(client, input.actor.accountId, input.actorAuthorizationVersion)) {
        return { status: "STALE_AUTHORIZATION" } as const;
      }
      const current = await lockBoundThreadContent(client, input);
      if (current === undefined) return { status: "THREAD_NOT_FOUND" } as const;
      const decision = checkContentMutation({
        action: "DELETE", actorAccountId: input.actor.accountId,
        canManageProject: input.actorCanManageProject,
        content: { authorAccountId: current.author_account_id, version: current.content_version, deleted: current.deleted_at !== null },
        thread: { status: current.status, deleted: current.deleted_at !== null },
        expectedVersion: input.expectedVersion,
      });
      if (decision !== "ALLOWED") return { status: decision };
      await client.query(
        `UPDATE rt_review_threads
         SET body = NULL,
             content_version = content_version + 1,
             deleted_by_account_id = $2,
             deleted_at = $3,
             updated_at = $3
         WHERE id = $1`,
        [input.threadId, input.actor.accountId, input.changedAt],
      );
      await this.#recordMutationEvent(client, input, "COMMENT_DELETED");
      await deleteReviewMentions(client, "COMMENT", input.threadId);
      const thread = await findPageCommentThreadById(client, input.threadId, 100);
      if (thread === undefined) throw new Error("deleted review thread disappeared");
      return { status: "UPDATED", thread } as const;
    });
  }

  async updateReply(
    input: Parameters<ReviewRepository["updateReply"]>[0],
  ): Promise<MutateReviewReplyResult> {
    return withReviewEventTransaction(this.#database, input, async (client) => {
      if (!await lockCurrentAccount(client, input.actor.accountId, input.actorAuthorizationVersion)) {
        return { status: "STALE_AUTHORIZATION" } as const;
      }
      const current = await lockBoundReplyContent(client, input);
      if (current === undefined) return { status: "REPLY_NOT_FOUND" } as const;
      const decision = checkContentMutation({
        action: "UPDATE", actorAccountId: input.actor.accountId,
        canManageProject: false,
        content: { authorAccountId: current.author_account_id, version: current.content_version, deleted: current.deleted_at !== null },
        thread: { status: current.thread_status, deleted: current.thread_deleted_at !== null },
        expectedVersion: input.expectedVersion,
      });
      if (decision !== "ALLOWED") return { status: decision };
      await client.query(
        `UPDATE rt_review_replies
         SET body = $2, content_version = content_version + 1, updated_at = $3
         WHERE id = $1`,
        [input.replyId, input.body, input.changedAt],
      );
      await touchThread(client, input.threadId, input.changedAt);
      await this.#recordMutationEvent(client, input, "REPLY_UPDATED");
      await syncReviewMentions(client, {
        ...mentionMutationInput(input, "REPLY", input.replyId),
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      const reply = await findReviewReplyById(client, input.replyId);
      if (reply === undefined) throw new Error("updated review reply disappeared");
      return { status: "UPDATED", reply } as const;
    });
  }

  async deleteReply(
    input: Parameters<ReviewRepository["deleteReply"]>[0],
  ): Promise<MutateReviewReplyResult> {
    return withReviewEventTransaction(this.#database, input, async (client) => {
      if (!await lockCurrentAccount(client, input.actor.accountId, input.actorAuthorizationVersion)) {
        return { status: "STALE_AUTHORIZATION" } as const;
      }
      const current = await lockBoundReplyContent(client, input);
      if (current === undefined) return { status: "REPLY_NOT_FOUND" } as const;
      const decision = checkContentMutation({
        action: "DELETE", actorAccountId: input.actor.accountId,
        canManageProject: input.actorCanManageProject,
        content: { authorAccountId: current.author_account_id, version: current.content_version, deleted: current.deleted_at !== null },
        thread: { status: current.thread_status, deleted: current.thread_deleted_at !== null },
        expectedVersion: input.expectedVersion,
      });
      if (decision !== "ALLOWED") return { status: decision };
      await client.query(
        `UPDATE rt_review_replies
         SET body = NULL,
             content_version = content_version + 1,
             deleted_by_account_id = $2,
             deleted_at = $3,
             updated_at = $3
         WHERE id = $1`,
        [input.replyId, input.actor.accountId, input.changedAt],
      );
      await touchThread(client, input.threadId, input.changedAt);
      await this.#recordMutationEvent(client, input, "REPLY_DELETED");
      await deleteReviewMentions(client, "REPLY", input.replyId);
      const reply = await findReviewReplyById(client, input.replyId);
      if (reply === undefined) throw new Error("deleted review reply disappeared");
      return { status: "UPDATED", reply } as const;
    });
  }

  async #recordMutationEvent(
    client: Queryable,
    input: Readonly<{
      revisionId: string;
      routePath: string;
      threadId: string;
      actor: ReviewIdentity;
      changedAt: Date;
    }>,
    type: ReviewEventType,
  ): Promise<void> {
    await recordReviewEvent(client, {
      revisionId: input.revisionId,
      routePath: input.routePath,
      threadId: input.threadId,
      type,
      actorAccountId: input.actor.accountId,
      occurredAt: input.changedAt,
      maxEvents: this.#maxEvents,
      maxEventAgeMs: this.#maxEventAgeMs,
    });
  }

  async listReviewEvents(input: Parameters<ReviewRepository["listReviewEvents"]>[0]): Promise<ListReviewEventsResult> {
    return withTransaction(this.#database, async (client) => {
      if (!await lockCurrentAccount(
        client,
        input.actorAccountId,
        input.actorAuthorizationVersion,
      )) return { status: "STALE_AUTHORIZATION" } as const;
      if (!await checkReviewAccess(client, input)) return { status: "BINDING_NOT_FOUND" } as const;
      const result = await client.query<(ReviewEventRow | { id: null }) & { trimmed_through_id: string }>(
        `WITH retention AS (
           SELECT COALESCE((SELECT trimmed_through_id FROM rt_review_event_retention
             WHERE revision_id = $1 AND route_path = $2), 0)::text AS trimmed_through_id
         ), events AS (
         SELECT event.id::text,
                event.revision_id,
                event.route_path,
                event.thread_id,
                event.event_type,
                event.actor_account_id,
                account.display_name AS actor_display_name,
                event.occurred_at
         FROM rt_review_events AS event
         JOIN rt_accounts AS account ON account.id = event.actor_account_id
         WHERE event.revision_id = $1
           AND event.route_path = $2
           AND event.id > $3::bigint
           AND (
             event.recipient_account_id IS NULL
             OR event.recipient_account_id = $5
           )
         ORDER BY event.id
         LIMIT $4
         )
         SELECT retention.trimmed_through_id, events.*
         FROM retention LEFT JOIN events ON true
         ORDER BY events.id::bigint`,
        [
          input.revisionId,
          input.routePath,
          input.afterId,
          input.limit,
          input.actorAccountId,
        ],
      );
      if (input.requireContinuity && BigInt(input.afterId) < BigInt(result.rows[0]?.trimmed_through_id ?? "0")) {
        return { status: "CURSOR_EXPIRED" } as const;
      }
      return { status: "FOUND", events: result.rows.flatMap((row) => row.id === null ? [] : [toReviewEvent(row)]) } as const;
    });
  }

  async listNotifications(
    input: Parameters<ReviewRepository["listNotifications"]>[0],
  ): Promise<ListReviewNotificationsResult> {
    return withTransaction(this.#database, async (client) => {
      const bindingStatus = await checkNotificationBinding(client, input);
      if (bindingStatus !== "FOUND") return { status: bindingStatus } as const;
      const result = await client.query<ReviewNotificationRow>(
        `${reviewNotificationSelect()}
         WHERE notification.revision_id = $1
           AND notification.route_path = $2
           AND notification.recipient_account_id = $3
         ORDER BY notification.id DESC
         LIMIT $4`,
        [input.revisionId, input.routePath, input.actorAccountId, input.limit],
      );
      return { status: "FOUND", notifications: result.rows.map(toReviewNotification) } as const;
    });
  }

  async setNotificationRead(
    input: Parameters<ReviewRepository["setNotificationRead"]>[0],
  ): Promise<SetReviewNotificationReadResult> {
    return withReviewEventTransaction(this.#database, input, async (client) => {
      const bindingStatus = await checkNotificationBinding(client, {
        ...input,
        actorAccountId: input.actor.accountId,
      });
      if (bindingStatus !== "FOUND") return { status: bindingStatus } as const;
      const updated = await client.query(
        `UPDATE rt_review_notifications
         SET read_at = CASE
           WHEN $5::boolean THEN COALESCE(read_at, $6::timestamptz)
           ELSE NULL
         END
         WHERE id = $1::bigint
           AND revision_id = $2
           AND route_path = $3
           AND recipient_account_id = $4
         RETURNING id`,
        [
          input.notificationId,
          input.revisionId,
          input.routePath,
          input.actor.accountId,
          input.read,
          input.changedAt,
        ],
      );
      if (updated.rowCount !== 1) return { status: "NOTIFICATION_NOT_FOUND" } as const;
      const result = await client.query<ReviewNotificationRow>(
        `${reviewNotificationSelect()} WHERE notification.id = $1::bigint`,
        [input.notificationId],
      );
      const notification = result.rows[0];
      if (notification === undefined) throw new Error("updated review notification disappeared");
      await recordReviewEvent(client, {
        revisionId: input.revisionId,
        routePath: input.routePath,
        threadId: notification.thread_id,
        type: "NOTIFICATION_READ_CHANGED",
        actorAccountId: input.actor.accountId,
        recipientAccountId: input.actor.accountId,
        occurredAt: input.changedAt,
        maxEvents: this.#maxEvents,
        maxEventAgeMs: this.#maxEventAgeMs,
      });
      return { status: "UPDATED", notification: toReviewNotification(notification) } as const;
    });
  }

  async listPageCommentPage(input: Parameters<ReviewRepository["listPageCommentPage"]>[0]): Promise<PageCommentPage> {
    return withTransaction(this.#database, (client) => readPageCommentSnapshot(client, input), "snapshot");
  }

  async listReplyPage(input: Parameters<ReviewRepository["listReplyPage"]>[0]): Promise<ReviewReplyPage | undefined> {
    const thread = await this.#database.query<{ status: ReviewThreadStatus }>(
      `SELECT status FROM rt_review_threads
       WHERE id = $1 AND revision_id = $2 AND route_path = $3`,
      [input.threadId, input.revisionId, input.routePath],
    );
    if (thread.rowCount !== 1) return undefined;
    const result = await this.#database.query<ReviewReplyRow>(
      `SELECT reply.id,
              reply.thread_id,
              reply.body,
              reply.content_version,
              reply.author_account_id,
              account.display_name AS author_display_name,
              reply.deleted_by_account_id,
              deleter.display_name AS deleted_by_display_name,
              reply.deleted_at,
              reply.created_at,
              reply.updated_at
       FROM rt_review_replies AS reply
       JOIN rt_accounts AS account ON account.id = reply.author_account_id
       LEFT JOIN rt_accounts AS deleter ON deleter.id = reply.deleted_by_account_id
       WHERE reply.thread_id = $1
         AND (
           $2::timestamptz IS NULL
           OR (reply.created_at, reply.id) < ($2::timestamptz, $3::text)
         )
       ORDER BY reply.created_at DESC, reply.id DESC
       LIMIT $4`,
      [
        input.threadId,
        input.before?.createdAt ?? null,
        input.before?.id ?? null,
        input.limit + 1,
      ],
    );
    const selected = result.rows.slice(0, input.limit);
    return {
      replies: selected.toReversed().map(toReviewReply),
      threadStatus: thread.rows[0]!.status,
      pageInfo: reviewPageInfo(result.rows.length > input.limit, selected.at(-1)),
    };
  }
}

type ReviewProjectRow = QueryResultRow & {
  id: string;
  owner_account_id: string;
  slug: string;
  display_name: string;
  created_at: Date;
};

type ReviewRevisionRow = QueryResultRow & {
  id: string;
  project_id: string;
  revision_key: string;
  created_by_account_id: string;
  created_at: Date;
};

type ReviewTunnelBindingRow = QueryResultRow & {
  tunnel_id: string;
  session_id: string;
  revision_id: string;
  owner_account_id: string;
  created_at: Date;
  expires_at: Date;
};

type ReviewBindingContextRow = QueryResultRow & {
  project_id_value: string;
  project_owner_account_id: string;
  project_slug: string;
  project_display_name: string;
  project_created_at: Date;
  revision_id_value: string;
  revision_project_id: string;
  revision_key_value: string;
  revision_created_by_account_id: string;
  revision_created_at: Date;
  binding_tunnel_id: string;
  binding_session_id: string;
  binding_revision_id: string;
  binding_owner_account_id: string;
  binding_created_at: Date;
  binding_expires_at: Date;
};

type PageCommentThreadRow = QueryResultRow & {
  id: string;
  revision_id: string;
  route_path: string;
  anchor_type: "PAGE" | "REGION";
  anchor: unknown | null;
  pin_number: number | null;
  body: string | null;
  content_version: number;
  workflow_version: number;
  status: ReviewThreadStatus;
  author_account_id: string;
  author_display_name: string;
  resolved_by_account_id: string | null;
  resolved_by_display_name: string | null;
  resolved_at: Date | null;
  deleted_by_account_id: string | null;
  deleted_by_display_name: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ReviewReplyRow = QueryResultRow & {
  id: string;
  thread_id: string;
  body: string | null;
  content_version: number;
  author_account_id: string;
  author_display_name: string;
  deleted_by_account_id: string | null;
  deleted_by_display_name: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ReviewEventRow = QueryResultRow & {
  id: string;
  revision_id: string;
  route_path: string;
  thread_id: string;
  event_type: ReviewEventType;
  actor_account_id: string;
  actor_display_name: string;
  occurred_at: Date;
};

type ReviewNotificationRow = QueryResultRow & {
  id: string;
  revision_id: string;
  route_path: string;
  thread_id: string;
  content_type: ReviewMentionContentType;
  reason: "MENTION" | "REPLY" | "WORKFLOW_REQUEST" | "WORKFLOW_RESULT";
  source_key: string;
  workflow_version: number | null;
  content_id: string;
  recipient_account_id: string;
  actor_account_id: string;
  actor_display_name: string;
  read_at: Date | null;
  created_at: Date;
};

type BoundThreadStatusRow = QueryResultRow & {
  status: ReviewThreadStatus;
  deleted_at: Date | null;
};

type BoundThreadContentRow = QueryResultRow & {
  workflow_version: number;
  status: ReviewThreadStatus;
  content_version: number;
  author_account_id: string;
  deleted_at: Date | null;
};

type BoundReplyContentRow = QueryResultRow & {
  thread_status: ReviewThreadStatus;
  thread_deleted_at: Date | null;
  content_version: number;
  author_account_id: string;
  deleted_at: Date | null;
};

async function lockCurrentAccount(
  database: Queryable,
  accountId: string,
  authorizationVersion: number,
): Promise<boolean> {
  const result = await database.query(
    `SELECT id FROM rt_accounts
     WHERE id = $1
       AND auth_version = $2
       AND enabled = true
       AND must_change_password = false
     FOR SHARE`,
    [accountId, authorizationVersion],
  );
  return result.rowCount === 1;
}

async function checkReviewAccess(database: Queryable, input: Readonly<{
  revisionId: string; tunnelId?: string; sessionId?: string; controlProjectId?: string;
}>): Promise<boolean> {
  if (input.controlProjectId !== undefined) {
    if (input.tunnelId !== undefined || input.sessionId !== undefined) return false;
    const result = await database.query(
      "SELECT 1 FROM rt_review_revisions WHERE id = $1 AND project_id = $2 FOR SHARE",
      [input.revisionId, input.controlProjectId],
    );
    return result.rowCount === 1;
  }
  if (input.tunnelId === undefined || input.sessionId === undefined) return false;
  const result = await database.query(
    `SELECT 1 FROM rt_review_tunnel_bindings WHERE tunnel_id = $1 AND session_id = $2 AND revision_id = $3 FOR SHARE`,
    [input.tunnelId, input.sessionId, input.revisionId],
  );
  return result.rowCount === 1;
}

async function checkNotificationBinding(
  database: Queryable,
  input: Readonly<{
    actorAccountId: string;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    revisionId: string;
  }>,
): Promise<"FOUND" | "BINDING_NOT_FOUND" | "STALE_AUTHORIZATION"> {
  if (!await lockCurrentAccount(
    database,
    input.actorAccountId,
    input.actorAuthorizationVersion,
  )) return "STALE_AUTHORIZATION";
  return await checkReviewAccess(database, input) ? "FOUND" : "BINDING_NOT_FOUND";
}

async function lockBoundThreadStatus(
  database: Queryable,
  input: Readonly<{
    threadId: string;
    revisionId: string;
    routePath: string;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
  }>,
): Promise<ReviewThreadStatus | "DELETED" | undefined> {
  if (!await checkReviewAccess(database, input)) return undefined;
  const result = await database.query<BoundThreadStatusRow>(
    `SELECT thread.status, thread.deleted_at
     FROM rt_review_threads AS thread
     WHERE thread.revision_id = $1
       AND thread.id = $2
       AND thread.route_path = $3
     FOR UPDATE OF thread`,
    [
      input.revisionId,
      input.threadId,
      input.routePath,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : row.deleted_at === null ? row.status : "DELETED";
}

async function lockBoundThreadContent(
  database: Queryable,
  input: Readonly<{
    threadId: string;
    revisionId: string;
    routePath: string;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
  }>,
): Promise<BoundThreadContentRow | undefined> {
  if (!await checkReviewAccess(database, input)) return undefined;
  const result = await database.query<BoundThreadContentRow>(
    `SELECT thread.status,
            thread.content_version, thread.workflow_version,
            thread.author_account_id,
            thread.deleted_at
     FROM rt_review_threads AS thread
     WHERE thread.revision_id = $1
       AND thread.id = $2
       AND thread.route_path = $3
     FOR UPDATE OF thread`,
    [input.revisionId, input.threadId, input.routePath],
  );
  return result.rows[0];
}

async function lockBoundReplyContent(
  database: Queryable,
  input: Readonly<{
    threadId: string;
    replyId: string;
    revisionId: string;
    routePath: string;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
  }>,
): Promise<BoundReplyContentRow | undefined> {
  if (!await checkReviewAccess(database, input)) return undefined;
  const result = await database.query<BoundReplyContentRow>(
    `SELECT thread.status AS thread_status,
            thread.deleted_at AS thread_deleted_at,
            reply.content_version,
            reply.author_account_id,
            reply.deleted_at
     FROM rt_review_threads AS thread
     JOIN rt_review_replies AS reply ON reply.thread_id = thread.id
     WHERE thread.revision_id = $1
       AND thread.id = $2
       AND thread.route_path = $3
       AND reply.id = $4
     FOR UPDATE OF thread, reply`,
    [
      input.revisionId,
      input.threadId,
      input.routePath,
      input.replyId,
    ],
  );
  return result.rows[0];
}

async function findBindingCollision(
  database: Queryable,
  tunnelId: string,
  sessionId: string,
): Promise<ReviewBindingContext | undefined> {
  const result = await database.query<ReviewBindingContextRow>(
    `${bindingContextSelect()}
     WHERE binding.tunnel_id = $1 OR binding.session_id = $2
     LIMIT 1
     FOR UPDATE OF binding`,
    [tunnelId, sessionId],
  );
  return optionalBindingContext(result.rows[0]);
}

async function findBindingContext(
  database: Queryable,
  tunnelId: string,
  sessionId: string,
): Promise<ReviewBindingContext | undefined> {
  const result = await database.query<ReviewBindingContextRow>(
    `${bindingContextSelect()}
     WHERE binding.tunnel_id = $1 AND binding.session_id = $2`,
    [tunnelId, sessionId],
  );
  return optionalBindingContext(result.rows[0]);
}

function bindingContextSelect(): string {
  return `SELECT project.id AS project_id_value,
                 project.owner_account_id AS project_owner_account_id,
                 project.slug AS project_slug,
                 project.display_name AS project_display_name,
                 project.created_at AS project_created_at,
                 revision.id AS revision_id_value,
                 revision.project_id AS revision_project_id,
                 revision.revision_key AS revision_key_value,
                 revision.created_by_account_id AS revision_created_by_account_id,
                 revision.created_at AS revision_created_at,
                 binding.tunnel_id AS binding_tunnel_id,
                 binding.session_id AS binding_session_id,
                 binding.revision_id AS binding_revision_id,
                 binding.owner_account_id AS binding_owner_account_id,
                 binding.created_at AS binding_created_at,
                 binding.expires_at AS binding_expires_at
          FROM rt_review_tunnel_bindings AS binding
          JOIN rt_review_revisions AS revision ON revision.id = binding.revision_id
          JOIN rt_review_projects AS project ON project.id = revision.project_id`;
}

function optionalBindingContext(
  row: ReviewBindingContextRow | undefined,
): ReviewBindingContext | undefined {
  return row === undefined ? undefined : {
    project: {
      id: row.project_id_value,
      ownerAccountId: row.project_owner_account_id,
      slug: row.project_slug,
      displayName: row.project_display_name,
      createdAt: row.project_created_at,
    },
    revision: {
      id: row.revision_id_value,
      projectId: row.revision_project_id,
      key: row.revision_key_value,
      createdByAccountId: row.revision_created_by_account_id,
      createdAt: row.revision_created_at,
    },
    binding: {
      tunnelId: row.binding_tunnel_id,
      sessionId: row.binding_session_id,
      revisionId: row.binding_revision_id,
      ownerAccountId: row.binding_owner_account_id,
      createdAt: row.binding_created_at,
      expiresAt: row.binding_expires_at,
    },
  };
}

function toProject(row: ReviewProjectRow): ReviewProject {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    slug: row.slug,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

function toRevision(row: ReviewRevisionRow): ReviewRevision {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.revision_key,
    createdByAccountId: row.created_by_account_id,
    createdAt: row.created_at,
  };
}

function toBinding(row: ReviewTunnelBindingRow): ReviewTunnelBinding {
  return {
    tunnelId: row.tunnel_id,
    sessionId: row.session_id,
    revisionId: row.revision_id,
    ownerAccountId: row.owner_account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

async function findPageCommentThreadById(
  database: Queryable,
  threadId: string,
  replyLimit: number,
): Promise<PageCommentThread | undefined> {
  const result = await database.query<PageCommentThreadRow>(
    `SELECT thread.id,
            thread.revision_id,
            thread.route_path,
            thread.anchor_type,
            thread.anchor,
            thread.pin_number,
            thread.body,
            thread.content_version, thread.workflow_version,
            thread.status,
            thread.author_account_id,
            account.display_name AS author_display_name,
            thread.resolved_by_account_id,
            resolver.display_name AS resolved_by_display_name,
            thread.resolved_at,
            thread.deleted_by_account_id,
            deleter.display_name AS deleted_by_display_name,
            thread.deleted_at,
            thread.created_at,
            thread.updated_at
     FROM rt_review_threads AS thread
     JOIN rt_accounts AS account ON account.id = thread.author_account_id
     LEFT JOIN rt_accounts AS resolver ON resolver.id = thread.resolved_by_account_id
     LEFT JOIN rt_accounts AS deleter ON deleter.id = thread.deleted_by_account_id
     WHERE thread.id = $1`,
    [threadId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const replyPages = await listReplyPagesForThreads(
    database,
    [{ id: threadId, status: row.status }],
    replyLimit,
  );
  const history = await database.query<{ version: number; from_status: ReviewThreadStatus; to_status: ReviewThreadStatus; actor_account_id: string; display_name: string; changed_at: Date }>(
    `SELECT history.*, account.display_name FROM (SELECT * FROM rt_review_workflow_history WHERE thread_id = $1 ORDER BY version DESC LIMIT 100) history JOIN rt_accounts account ON account.id = history.actor_account_id ORDER BY version`, [threadId]);
  const thread = toPageCommentThread(row, replyPages.get(threadId)?.replies ?? []);
  return { ...thread, workflowHistory: history.rows.map(item => ({ version: item.version, from: item.from_status, to: item.to_status, actor: { accountId: item.actor_account_id, displayName: item.display_name }, changedAt: item.changed_at })) };
}

async function findReviewReplyById(
  database: Queryable,
  replyId: string,
): Promise<ReviewReply | undefined> {
  const result = await database.query<ReviewReplyRow>(
    `SELECT reply.id,
            reply.thread_id,
            reply.body,
            reply.content_version,
            reply.author_account_id,
            account.display_name AS author_display_name,
            reply.deleted_by_account_id,
            deleter.display_name AS deleted_by_display_name,
            reply.deleted_at,
            reply.created_at,
            reply.updated_at
     FROM rt_review_replies AS reply
     JOIN rt_accounts AS account ON account.id = reply.author_account_id
     LEFT JOIN rt_accounts AS deleter ON deleter.id = reply.deleted_by_account_id
     WHERE reply.id = $1`,
    [replyId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toReviewReply(row);
}

async function touchThread(database: Queryable, threadId: string, changedAt: Date): Promise<void> {
  await database.query(
    "UPDATE rt_review_threads SET updated_at = $2 WHERE id = $1",
    [threadId, changedAt],
  );
}

async function allocateReviewPinNumber(
  database: Queryable,
  revisionId: string,
  routePath: string,
): Promise<number> {
  const result = await database.query<{ pin_number: number }>(
    `INSERT INTO rt_review_pin_counters (revision_id, route_path, next_pin_number)
     VALUES ($1, $2, 2)
     ON CONFLICT (revision_id, route_path) DO UPDATE
     SET next_pin_number = rt_review_pin_counters.next_pin_number + 1
     RETURNING next_pin_number - 1 AS pin_number`,
    [revisionId, routePath],
  );
  return normalizePinNumber(result.rows[0]!.pin_number);
}

async function listReplyPagesForThreads(
  database: Queryable,
  threads: readonly Readonly<{ id: string; status: ReviewThreadStatus }>[],
  replyLimit: number,
): Promise<ReadonlyMap<string, ReviewReplyPage>> {
  const grouped = new Map<string, ReviewReplyRow[]>();
  if (threads.length === 0) return new Map();
  const result = await database.query<ReviewReplyRow>(
    `SELECT bounded.id,
            bounded.thread_id,
            bounded.body,
            bounded.content_version,
            bounded.author_account_id,
            bounded.author_display_name,
            bounded.deleted_by_account_id,
            bounded.deleted_by_display_name,
            bounded.deleted_at,
            bounded.created_at,
            bounded.updated_at
     FROM (
       SELECT reply.id,
              reply.thread_id,
              reply.body,
              reply.content_version,
              reply.author_account_id,
              account.display_name AS author_display_name,
              reply.deleted_by_account_id,
              deleter.display_name AS deleted_by_display_name,
              reply.deleted_at,
              reply.created_at,
              reply.updated_at,
              row_number() OVER (
                PARTITION BY reply.thread_id
                ORDER BY reply.created_at DESC, reply.id DESC
              ) AS reply_number
       FROM rt_review_replies AS reply
       JOIN rt_accounts AS account ON account.id = reply.author_account_id
       LEFT JOIN rt_accounts AS deleter ON deleter.id = reply.deleted_by_account_id
       WHERE reply.thread_id = ANY($1::text[])
     ) AS bounded
     WHERE bounded.reply_number <= $2
     ORDER BY bounded.thread_id, bounded.created_at DESC, bounded.id DESC`,
    [threads.map((thread) => thread.id), replyLimit + 1],
  );
  for (const row of result.rows) {
    const replies = grouped.get(row.thread_id) ?? [];
    replies.push(row);
    grouped.set(row.thread_id, replies);
  }
  return new Map(threads.map((thread) => {
    const rows = grouped.get(thread.id) ?? [];
    const selected = rows.slice(0, replyLimit);
    return [thread.id, {
      replies: selected.toReversed().map(toReviewReply),
      threadStatus: thread.status,
      pageInfo: reviewPageInfo(rows.length > replyLimit, selected.at(-1)),
    }];
  }));
}

function emptyReplyPage(threadStatus: ReviewThreadStatus): ReviewReplyPage {
  return { replies: [], threadStatus, pageInfo: { hasMore: false } };
}

function reviewPageInfo(
  hasMore: boolean,
  oldest: Readonly<{ id: string; created_at: Date }> | undefined,
): ReviewReplyPage["pageInfo"] {
  if (!hasMore || oldest === undefined) return { hasMore: false };
  return {
    hasMore: true,
    nextCursor: encodeReviewPageCursor({ createdAt: oldest.created_at, id: oldest.id }),
  };
}

function mentionMutationInput(
  input: Readonly<{
    revisionId: string;
    routePath: string;
    threadId: string;
    mentionUsernames: readonly string[];
    actor: ReviewIdentity;
    changedAt: Date;
  }>,
  contentType: ReviewMentionContentType,
  contentId: string,
) {
  return {
    revisionId: input.revisionId,
    routePath: input.routePath,
    threadId: input.threadId,
    contentType,
    contentId,
    mentionUsernames: input.mentionUsernames,
    actorAccountId: input.actor.accountId,
    occurredAt: input.changedAt,
  } as const;
}

async function deleteReviewMentions(
  database: Queryable,
  contentType: ReviewMentionContentType,
  contentId: string,
): Promise<void> {
  await database.query(
    `DELETE FROM rt_review_mentions
     WHERE content_type = $1 AND content_id = $2`,
    [contentType, contentId],
  );
}

async function syncReviewMentions(
  database: Queryable,
  input: Readonly<{
    revisionId: string;
    routePath: string;
    threadId: string;
    contentType: ReviewMentionContentType;
    contentId: string;
    mentionUsernames: readonly string[];
    actorAccountId: string;
    occurredAt: Date;
    maxEvents: number;
    maxEventAgeMs: number;
  }>,
): Promise<void> {
  const previousResult = await database.query<{ recipient_account_id: string }>(
    `SELECT recipient_account_id
     FROM rt_review_mentions
     WHERE content_type = $1 AND content_id = $2
     FOR UPDATE`,
    [input.contentType, input.contentId],
  );
  const previousRecipients = new Set(
    previousResult.rows.map((row) => row.recipient_account_id),
  );
  const eligibleResult = input.mentionUsernames.length === 0
    ? { rows: [] as { account_id: string }[] }
    : await database.query<{ account_id: string }>(
      `WITH participants(account_id) AS (
         SELECT project.owner_account_id
         FROM rt_review_revisions AS revision
         JOIN rt_review_projects AS project ON project.id = revision.project_id
         WHERE revision.id = $1
         UNION
         SELECT thread.author_account_id
         FROM rt_review_threads AS thread
         WHERE thread.revision_id = $1
         UNION
         SELECT reply.author_account_id
         FROM rt_review_replies AS reply
         JOIN rt_review_threads AS thread ON thread.id = reply.thread_id
         WHERE thread.revision_id = $1
       )
       SELECT account.id AS account_id
       FROM participants
       JOIN rt_accounts AS account ON account.id = participants.account_id
       WHERE account.username = ANY($2::text[])
         AND account.id <> $3
         AND account.enabled = true
         AND account.must_change_password = false
         AND account.roles && ARRAY['DEVELOPER','REVIEWER']::text[]
       ORDER BY account.id`,
      [input.revisionId, input.mentionUsernames, input.actorAccountId],
    );
  const contentVersion = (await database.query<{ content_version: number }>(input.contentType === "COMMENT" ? "SELECT content_version FROM rt_review_threads WHERE id = $1" : "SELECT content_version FROM rt_review_replies WHERE id = $1", [input.contentId])).rows[0]?.content_version ?? 1;
  const sourceKey = `mention:${input.contentType}:${input.contentId}:${contentVersion}`;
  await deleteReviewMentions(database, input.contentType, input.contentId);
  for (const { account_id: recipientAccountId } of eligibleResult.rows) {
    await database.query(
      `INSERT INTO rt_review_mentions
       (revision_id, route_path, thread_id, content_type, content_id,
        recipient_account_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.revisionId,
        input.routePath,
        input.threadId,
        input.contentType,
        input.contentId,
        recipientAccountId,
        input.occurredAt,
      ],
    );
    if (previousRecipients.has(recipientAccountId)) continue;
    await database.query(
      `INSERT INTO rt_review_notifications
       (revision_id, route_path, thread_id, content_type, content_id,
        recipient_account_id, actor_account_id, created_at, source_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (recipient_account_id, source_key) DO NOTHING`,
      [
        input.revisionId,
        input.routePath,
        input.threadId,
        input.contentType,
        input.contentId,
        recipientAccountId,
        input.actorAccountId,
        input.occurredAt,
        sourceKey,
      ],
    );
    await recordReviewEvent(database, {
      revisionId: input.revisionId,
      routePath: input.routePath,
      threadId: input.threadId,
      type: "NOTIFICATION_CREATED",
      actorAccountId: input.actorAccountId,
      recipientAccountId,
      occurredAt: input.occurredAt,
      maxEvents: input.maxEvents,
      maxEventAgeMs: input.maxEventAgeMs,
    });
  }
}

function reviewNotificationSelect(): string {
  return `SELECT notification.id::text,
                 notification.revision_id,
                 notification.route_path,
                 notification.thread_id,
                 notification.content_type, notification.reason, notification.source_key, notification.workflow_version,
                 notification.content_id,
                 notification.recipient_account_id,
                 notification.actor_account_id,
                 actor.display_name AS actor_display_name,
                 notification.read_at,
                 notification.created_at
          FROM rt_review_notifications AS notification
          JOIN rt_accounts AS actor ON actor.id = notification.actor_account_id`;
}

function toReviewNotification(row: ReviewNotificationRow): ReviewNotification {
  return {
    id: row.id,
    revisionId: row.revision_id,
    routePath: row.route_path,
    threadId: row.thread_id,
    contentType: row.content_type,
    reason: row.reason,
    sourceKey: row.source_key,
    ...(row.workflow_version === null ? {} : { workflowVersion: row.workflow_version }),
    contentId: row.content_id,
    recipientAccountId: row.recipient_account_id,
    actor: {
      accountId: row.actor_account_id,
      displayName: row.actor_display_name,
    },
    ...(row.read_at === null ? {} : { readAt: row.read_at }),
    createdAt: row.created_at,
  };
}

async function recordReviewEvent(
  database: Queryable,
  input: Readonly<{
    revisionId: string;
    routePath: string;
    threadId: string;
    type: ReviewEventType;
    actorAccountId: string;
    occurredAt: Date;
    maxEvents: number;
    maxEventAgeMs: number;
    recipientAccountId?: string;
  }>,
): Promise<void> {
  await database.query(
    `INSERT INTO rt_review_events
     (revision_id, route_path, thread_id, event_type, actor_account_id,
      recipient_account_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.revisionId,
      input.routePath,
      input.threadId,
      input.type,
      input.actorAccountId,
      input.recipientAccountId ?? null,
      input.occurredAt,
    ],
  );
  await database.query(
    `WITH removed AS (
     DELETE FROM rt_review_events
     WHERE occurred_at < $1
        OR id <= COALESCE((
          SELECT id
          FROM rt_review_events
          ORDER BY id DESC
          OFFSET $2 LIMIT 1
        ), 0)
     RETURNING revision_id, route_path, id
     )
     INSERT INTO rt_review_event_retention (revision_id, route_path, trimmed_through_id)
     SELECT revision_id, route_path, max(id) FROM removed
     GROUP BY revision_id, route_path ORDER BY revision_id, route_path
     ON CONFLICT (revision_id, route_path) DO UPDATE
     SET trimmed_through_id = GREATEST(rt_review_event_retention.trimmed_through_id, EXCLUDED.trimmed_through_id)`,
    [new Date(input.occurredAt.getTime() - input.maxEventAgeMs), input.maxEvents],
  );
}

function toReviewEvent(row: ReviewEventRow): ReviewEvent {
  return {
    id: row.id,
    revisionId: row.revision_id,
    routePath: row.route_path,
    threadId: row.thread_id,
    type: row.event_type,
    actor: {
      accountId: row.actor_account_id,
      displayName: row.actor_display_name,
    },
    occurredAt: row.occurred_at,
  };
}

function toPageCommentThread(
  row: PageCommentThreadRow,
  replies: readonly ReviewReply[],
): PageCommentThread {
  const resolution = row.resolved_by_account_id === null || row.resolved_at === null
    ? {}
    : {
        resolvedBy: {
          accountId: row.resolved_by_account_id,
          displayName: row.resolved_by_display_name!,
        },
        resolvedAt: row.resolved_at,
      };
  const deletion = row.deleted_by_account_id === null || row.deleted_at === null
    ? {}
    : {
        deletedBy: {
          accountId: row.deleted_by_account_id,
          displayName: row.deleted_by_display_name!,
        },
        deletedAt: row.deleted_at,
      };
  return {
    id: row.id,
    revisionId: row.revision_id,
    routePath: row.route_path,
    anchor: row.anchor_type === "PAGE"
      ? { type: "PAGE" }
      : normalizeRegionAnchor(row.anchor),
    ...(row.anchor_type === "REGION"
      ? { pinNumber: normalizePinNumber(row.pin_number!) }
      : {}),
    body: row.body,
    version: row.content_version,
    workflowVersion: row.workflow_version,
    status: row.status,
    author: {
      accountId: row.author_account_id,
      displayName: row.author_display_name,
    },
    ...resolution,
    ...deletion,
    replies,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReviewReply(row: ReviewReplyRow): ReviewReply {
  const deletion = row.deleted_by_account_id === null || row.deleted_at === null
    ? {}
    : {
        deletedBy: {
          accountId: row.deleted_by_account_id,
          displayName: row.deleted_by_display_name!,
        },
        deletedAt: row.deleted_at,
      };
  return {
    id: row.id,
    threadId: row.thread_id,
    body: row.body,
    version: row.content_version,
    author: {
      accountId: row.author_account_id,
      displayName: row.author_display_name,
    },
    ...deletion,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readPageCommentSnapshot(database: Queryable,
  input: Parameters<ReviewRepository["listPageCommentPage"]>[0]): Promise<PageCommentPage> {
    const eventCursorResult = await database.query<{ event_cursor: string }>(
      `SELECT GREATEST(COALESCE(max(id), 0), COALESCE((
         SELECT max(trimmed_through_id) FROM rt_review_event_retention
         WHERE revision_id = $1 AND ($2::text IS NULL OR route_path = $2)
       ), 0))::text AS event_cursor
       FROM rt_review_events
       WHERE revision_id = $1 AND ($2::text IS NULL OR route_path = $2)`,
      [input.revisionId, input.routePath ?? null],
    );
    const [result, openCountResult, filteredCountResult] = await Promise.all([
      database.query<PageCommentThreadRow>(
      `SELECT thread.id,
              thread.revision_id,
              thread.route_path,
              thread.anchor_type,
              thread.anchor,
              thread.pin_number,
              thread.body,
              thread.content_version, thread.workflow_version,
              thread.status,
              thread.author_account_id,
              account.display_name AS author_display_name,
              thread.resolved_by_account_id,
              resolver.display_name AS resolved_by_display_name,
              thread.resolved_at,
              thread.deleted_by_account_id,
              deleter.display_name AS deleted_by_display_name,
              thread.deleted_at,
              thread.created_at,
              thread.updated_at
       FROM rt_review_threads AS thread
       JOIN rt_accounts AS account ON account.id = thread.author_account_id
       LEFT JOIN rt_accounts AS resolver ON resolver.id = thread.resolved_by_account_id
       LEFT JOIN rt_accounts AS deleter ON deleter.id = thread.deleted_by_account_id
       WHERE thread.revision_id = $1
         AND ($2::text IS NULL OR thread.route_path = $2)
         AND ($6::text IS NULL OR ($6 = 'OPEN' AND thread.status <> 'RESOLVED') OR thread.status = $6)
         AND ($7::text IS NULL OR thread.author_account_id = $7)
         AND (
           $3::timestamptz IS NULL
           OR (thread.created_at, thread.id) < ($3::timestamptz, $4::text)
         )
       ORDER BY thread.created_at DESC, thread.id DESC
       LIMIT $5`,
        [
          input.revisionId,
          input.routePath ?? null,
          input.before?.createdAt ?? null,
          input.before?.id ?? null,
          input.limit + 1,
          input.status ?? null,
          input.authorAccountId ?? null,
        ],
      ),
      database.query<{ open_count: string }>(
         `SELECT count(*)::text AS open_count
         FROM rt_review_threads
         WHERE revision_id = $1
           AND ($2::text IS NULL OR route_path = $2)
           AND status <> 'RESOLVED'
           AND deleted_at IS NULL`,
        [input.revisionId, input.routePath ?? null],
      ),
      database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM rt_review_threads
         WHERE revision_id = $1 AND ($2::text IS NULL OR route_path = $2)
           AND ($3::text IS NULL OR ($3 = 'OPEN' AND status <> 'RESOLVED') OR status = $3)
           AND ($4::text IS NULL OR author_account_id = $4)`,
        [input.revisionId, input.routePath ?? null, input.status ?? null, input.authorAccountId ?? null],
      ),
    ]);
    const selected = result.rows.slice(0, input.limit);
    const replies = input.summaryOnly ? new Map<string, ReviewReplyPage>() : await listReplyPagesForThreads(
      database,
      selected.map((row) => ({ id: row.id, status: row.status })),
      input.replyLimit,
    );
    return {
      comments: selected.toReversed().map((row) => {
        const replyPage = replies.get(row.id) ?? emptyReplyPage(row.status);
        return {
          ...toPageCommentThread(row, replyPage.replies),
          replyPageInfo: replyPage.pageInfo,
        };
      }),
      openCount: Number.parseInt(openCountResult.rows[0]?.open_count ?? "0", 10),
      filteredCount: Number(filteredCountResult.rows[0]?.count ?? "0"),
      eventCursor: eventCursorResult.rows[0]?.event_cursor ?? "0",
      pageInfo: reviewPageInfo(result.rows.length > input.limit, selected.at(-1)),
    };
}
