import type {
  PageCommentThread,
  PageCommentPage,
  ReviewBindingContext,
  ReviewProject,
  ReviewIdentity,
  ReviewEvent,
  ReviewNotification,
  ReviewReply,
  ReviewReplyPage,
  ReviewPageCursor,
  ReviewRevision,
  ReviewThreadStatus,
  ReviewTunnelBinding,
} from "./model.ts";

export type BindReviewTunnelInput = Readonly<{
  project: ReviewProject;
  revision: ReviewRevision;
  binding: ReviewTunnelBinding;
  actorUsername: string;
  actorAuthorizationVersion: number;
}>;

export type BindReviewTunnelResult =
  | Readonly<{ status: "BOUND"; context: ReviewBindingContext }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>
  | Readonly<{ status: "CONFLICT" }>;

export type CreatePageCommentResult =
  | Readonly<{ status: "CREATED"; thread: PageCommentThread }>
  | Readonly<{ status: "BINDING_NOT_FOUND" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export type CreateReviewReplyResult =
  | Readonly<{ status: "CREATED"; reply: ReviewReply }>
  | Readonly<{ status: "THREAD_NOT_FOUND" }>
  | Readonly<{ status: "STATE_CONFLICT" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export type ChangePageCommentStatusResult =
  | Readonly<{ status: "REVIEWER_UNAVAILABLE" }>
  | Readonly<{ status: "UPDATED"; thread: PageCommentThread }>
  | Readonly<{ status: "THREAD_NOT_FOUND" }>
  | Readonly<{ status: "STATE_CONFLICT" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export type ListReviewEventsResult =
  | Readonly<{ status: "FOUND"; events: readonly ReviewEvent[] }>
  | Readonly<{ status: "CURSOR_EXPIRED" }>
  | Readonly<{ status: "BINDING_NOT_FOUND" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export type ListReviewNotificationsResult =
  | Readonly<{ status: "FOUND"; notifications: readonly ReviewNotification[] }>
  | Readonly<{ status: "BINDING_NOT_FOUND" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export type SetReviewNotificationReadResult =
  | Readonly<{ status: "UPDATED"; notification: ReviewNotification }>
  | Readonly<{ status: "NOTIFICATION_NOT_FOUND" }>
  | Readonly<{ status: "BINDING_NOT_FOUND" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export type MutateReviewCommentResult =
  | Readonly<{ status: "UPDATED"; thread: PageCommentThread }>
  | Readonly<{ status: "THREAD_NOT_FOUND" }>
  | Readonly<{ status: "FORBIDDEN" }>
  | Readonly<{ status: "STATE_CONFLICT" }>
  | Readonly<{ status: "VERSION_CONFLICT" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export type MutateReviewReplyResult =
  | Readonly<{ status: "UPDATED"; reply: ReviewReply }>
  | Readonly<{ status: "THREAD_NOT_FOUND" }>
  | Readonly<{ status: "REPLY_NOT_FOUND" }>
  | Readonly<{ status: "FORBIDDEN" }>
  | Readonly<{ status: "STATE_CONFLICT" }>
  | Readonly<{ status: "VERSION_CONFLICT" }>
  | Readonly<{ status: "STALE_AUTHORIZATION" }>;

export interface ReviewRepository {
  checkHealth(): Promise<void>;
  listProjects(): Promise<readonly (ReviewProject & { openCount: number; lastActivityAt: Date })[]>;
  listRevisions(projectId: string): Promise<readonly (ReviewRevision & { openCount: number })[]>;
  findRevisionContext(projectId: string | undefined, revisionId: string): Promise<{ project: ReviewProject; revision: ReviewRevision } | undefined>;
  findThread(threadId: string): Promise<PageCommentPage["comments"][number] | undefined>;
  listInbox(input: Readonly<{ actorAccountId: string; before?: string; unreadOnly: boolean }>): Promise<{ notifications: readonly ReviewNotification[]; unreadCount: number; nextCursor?: string }>;
  findNotificationForAccount(id: string, accountId: string): Promise<ReviewNotification | undefined>;
  listMentionCandidates(revisionId: string, prefix: string): Promise<readonly { username: string; displayName: string }[]>;

  bindTunnel(input: BindReviewTunnelInput): Promise<BindReviewTunnelResult>;
  findBindingContext(input: Readonly<{
    tunnelId: string;
    sessionId: string;
  }>): Promise<ReviewBindingContext | undefined>;
  removeTunnelBinding(input: Readonly<{
    tunnelId: string;
    sessionId: string;
  }>): Promise<void>;
  createPageComment(input: Readonly<{
    thread: PageCommentThread;
    actorUsername: string;
    mentionUsernames: readonly string[];
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
  }>): Promise<CreatePageCommentResult>;
  createReply(input: Readonly<{
    reply: ReviewReply;
    actorUsername: string;
    mentionUsernames: readonly string[];
    revisionId: string;
    routePath: string;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
  }>): Promise<CreateReviewReplyResult>;
  changePageCommentStatus(input: Readonly<{
    threadId: string;
    revisionId: string;
    routePath: string;
    expectedStatus: ReviewThreadStatus;
    expectedWorkflowVersion: number;
    actorCanManageProject: boolean;
    status: ReviewThreadStatus;
    actor: ReviewIdentity;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    changedAt: Date;
  }>): Promise<ChangePageCommentStatusResult>;
  listPageCommentPage(input: Readonly<{
    revisionId: string;
    routePath?: string;
    before?: ReviewPageCursor;
    limit: number;
    replyLimit: number;
    summaryOnly?: boolean;
    status?: "OPEN" | "RESOLVED";
    authorAccountId?: string;
  }>): Promise<PageCommentPage>;
  listReplyPage(input: Readonly<{
    revisionId: string;
    routePath: string;
    threadId: string;
    before?: ReviewPageCursor;
    limit: number;
  }>): Promise<ReviewReplyPage | undefined>;
  listReviewEvents(input: Readonly<{
    revisionId: string;
    routePath: string;
    afterId: string;
    requireContinuity?: boolean;
    limit: number;
    actorAccountId: string;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
  }>): Promise<ListReviewEventsResult>;
  listNotifications(input: Readonly<{
    revisionId: string;
    routePath: string;
    limit: number;
    actorAccountId: string;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
  }>): Promise<ListReviewNotificationsResult>;
  setNotificationRead(input: Readonly<{
    notificationId: string;
    revisionId: string;
    routePath: string;
    read: boolean;
    actor: ReviewIdentity;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    changedAt: Date;
  }>): Promise<SetReviewNotificationReadResult>;
  updateComment(input: Readonly<{
    threadId: string;
    revisionId: string;
    routePath: string;
    expectedVersion: number;
    body: string;
    actorUsername: string;
    mentionUsernames: readonly string[];
    actor: ReviewIdentity;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    changedAt: Date;
  }>): Promise<MutateReviewCommentResult>;
  deleteComment(input: Readonly<{
    threadId: string;
    revisionId: string;
    routePath: string;
    expectedVersion: number;
    actor: ReviewIdentity;
    actorCanManageProject: boolean;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    changedAt: Date;
  }>): Promise<MutateReviewCommentResult>;
  updateReply(input: Readonly<{
    threadId: string;
    replyId: string;
    revisionId: string;
    routePath: string;
    expectedVersion: number;
    body: string;
    actorUsername: string;
    mentionUsernames: readonly string[];
    actor: ReviewIdentity;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    changedAt: Date;
  }>): Promise<MutateReviewReplyResult>;
  deleteReply(input: Readonly<{
    threadId: string;
    replyId: string;
    revisionId: string;
    routePath: string;
    expectedVersion: number;
    actor: ReviewIdentity;
    actorCanManageProject: boolean;
    actorAuthorizationVersion: number;
    tunnelId?: string;
    sessionId?: string;
    controlProjectId?: string;
    changedAt: Date;
  }>): Promise<MutateReviewReplyResult>;
}
