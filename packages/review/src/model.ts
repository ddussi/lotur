export const MAX_PROJECT_SLUG_LENGTH = 64;
export const MAX_REVISION_KEY_LENGTH = 128;
export const MAX_ROUTE_PATH_LENGTH = 2_048;
export const MAX_COMMENT_BODY_LENGTH = 4_000;
export const MAX_REPLY_BODY_LENGTH = 4_000;
export const MAX_MENTIONS_PER_BODY = 20;

export type ReviewErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STATE_CONFLICT"
  | "VERSION_CONFLICT";

export class ReviewError extends Error {
  readonly code: ReviewErrorCode;

  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
  }
}

export type ReviewCapabilities = Readonly<{
  canRead: boolean;
  canComment: boolean;
  canManageProject: boolean;
}>;

export type ReviewActor = Readonly<{
  accountId: string;
  username: string;
  authorizationVersion: number;
  displayName: string;
  capabilities: ReviewCapabilities;
}>;

export type ReviewProject = Readonly<{
  id: string;
  ownerAccountId: string;
  slug: string;
  displayName: string;
  createdAt: Date;
}>;

export type ReviewRevision = Readonly<{
  id: string;
  projectId: string;
  key: string;
  createdByAccountId: string;
  createdAt: Date;
}>;

export type ReviewTunnelBinding = Readonly<{
  tunnelId: string;
  sessionId: string;
  revisionId: string;
  ownerAccountId: string;
  createdAt: Date;
  expiresAt: Date;
}>;

export type ReviewBindingContext = Readonly<{
  project: ReviewProject;
  revision: ReviewRevision;
  binding: ReviewTunnelBinding;
}>;

export type ReviewThreadStatus = "OPEN" | "RESOLVED";

export function isOpenReviewThread(
  thread: Readonly<{ status: ReviewThreadStatus; deletedAt?: Date }>,
): boolean {
  return thread.status === "OPEN" && thread.deletedAt === undefined;
}

export type ReviewEventType =
  | "COMMENT_CREATED"
  | "REPLY_CREATED"
  | "THREAD_STATUS_CHANGED"
  | "COMMENT_UPDATED"
  | "COMMENT_DELETED"
  | "REPLY_UPDATED"
  | "REPLY_DELETED"
  | "NOTIFICATION_CREATED"
  | "NOTIFICATION_READ_CHANGED";

export type ReviewIdentity = Readonly<{
  accountId: string;
  displayName: string;
}>;

export type ReviewEvent = Readonly<{
  id: string;
  revisionId: string;
  routePath: string;
  threadId: string;
  type: ReviewEventType;
  actor: ReviewIdentity;
  occurredAt: Date;
  recipientAccountId?: string;
}>;

export type ReviewMentionContentType = "COMMENT" | "REPLY";

export type ReviewNotification = Readonly<{
  id: string;
  revisionId: string;
  routePath: string;
  threadId: string;
  contentType: ReviewMentionContentType;
  contentId: string;
  recipientAccountId: string;
  actor: ReviewIdentity;
  readAt?: Date;
  createdAt: Date;
}>;

export type ReviewReply = Readonly<{
  id: string;
  threadId: string;
  body: string | null;
  version: number;
  author: ReviewIdentity;
  deletedBy?: ReviewIdentity;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PageReviewAnchor = Readonly<{ type: "PAGE" }>;

export type RegionReviewAnchorV1 = Readonly<{
  type: "REGION_V1";
  selection: "POINT" | "RECT";
  x: number;
  y: number;
  width: number;
  height: number;
  document: Readonly<{ width: number; height: number }>;
  viewport: Readonly<{ width: number; height: number }>;
}>;

export type ReviewAnchor = PageReviewAnchor | RegionReviewAnchorV1;

export type PageCommentThread = Readonly<{
  id: string;
  revisionId: string;
  routePath: string;
  anchor: ReviewAnchor;
  pinNumber?: number;
  body: string | null;
  version: number;
  status: ReviewThreadStatus;
  author: ReviewIdentity;
  resolvedBy?: ReviewIdentity;
  resolvedAt?: Date;
  deletedBy?: ReviewIdentity;
  deletedAt?: Date;
  replies: readonly ReviewReply[];
  createdAt: Date;
  updatedAt: Date;
}>;

export type ReviewPageCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export type ReviewPageInfo = Readonly<{
  hasMore: boolean;
  nextCursor?: string;
}>;

export type PageCommentPageItem = PageCommentThread & Readonly<{
  replyPageInfo: ReviewPageInfo;
}>;

export type PageCommentPage = Readonly<{
  comments: readonly PageCommentPageItem[];
  openCount: number;
  eventCursor: string;
  pageInfo: ReviewPageInfo;
}>;

export type ReviewReplyPage = Readonly<{
  replies: readonly ReviewReply[];
  threadStatus: ReviewThreadStatus;
  pageInfo: ReviewPageInfo;
}>;

const MAX_CAPTURE_DIMENSION = 1_000_000;
const REGION_COORDINATE_PRECISION = 1_000_000;

export function normalizeRegionAnchor(value: unknown): RegionReviewAnchorV1 {
  const anchor = requireRecord(value, "review region anchor");
  requireExactKeys(anchor, [
    "type",
    "selection",
    "x",
    "y",
    "width",
    "height",
    "document",
    "viewport",
  ], "review region anchor");
  if (anchor.type !== "REGION_V1") {
    throw new ReviewError("INVALID_INPUT", "review region anchor type is invalid");
  }
  if (anchor.selection !== "POINT" && anchor.selection !== "RECT") {
    throw new ReviewError("INVALID_INPUT", "review region selection is invalid");
  }
  const x = normalizeUnitCoordinate(anchor.x, "review region x");
  const y = normalizeUnitCoordinate(anchor.y, "review region y");
  const width = normalizeUnitCoordinate(anchor.width, "review region width");
  const height = normalizeUnitCoordinate(anchor.height, "review region height");
  if (
    (anchor.selection === "POINT" && (width !== 0 || height !== 0)) ||
    (anchor.selection === "RECT" && (width === 0 || height === 0)) ||
    x + width > 1 ||
    y + height > 1
  ) {
    throw new ReviewError("INVALID_INPUT", "review region geometry is invalid");
  }
  return {
    type: "REGION_V1",
    selection: anchor.selection,
    x,
    y,
    width,
    height,
    document: normalizeCaptureDimensions(anchor.document, "review document"),
    viewport: normalizeCaptureDimensions(anchor.viewport, "review viewport"),
  };
}

function normalizeUnitCoordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ReviewError("INVALID_INPUT", `${name} is invalid`);
  }
  return Math.round(value * REGION_COORDINATE_PRECISION) / REGION_COORDINATE_PRECISION;
}

function normalizeCaptureDimensions(
  value: unknown,
  name: string,
): Readonly<{ width: number; height: number }> {
  const dimensions = requireRecord(value, name);
  requireExactKeys(dimensions, ["width", "height"], name);
  const normalizeDimension = (dimension: unknown): number => {
    if (
      typeof dimension !== "number" ||
      !Number.isFinite(dimension) ||
      dimension <= 0 ||
      dimension > MAX_CAPTURE_DIMENSION
    ) throw new ReviewError("INVALID_INPUT", `${name} dimensions are invalid`);
    return Math.round(dimension * 1_000) / 1_000;
  };
  return {
    width: normalizeDimension(dimensions.width),
    height: normalizeDimension(dimensions.height),
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewError("INVALID_INPUT", `${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new ReviewError("INVALID_INPUT", `${name} fields are invalid`);
  }
}

export function normalizeProjectSlug(value: string): string {
  if (
    value.length > MAX_PROJECT_SLUG_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  ) {
    throw new ReviewError("INVALID_INPUT", "project slug is invalid");
  }
  return value;
}

export function normalizeRevisionKey(value: string): string {
  if (
    value.length > MAX_REVISION_KEY_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/.test(value)
  ) {
    throw new ReviewError("INVALID_INPUT", "review revision key is invalid");
  }
  return value;
}

export function normalizeRoutePath(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Review paths intentionally reject ASCII control characters.
  const hasControlCharacters = /[\u0000-\u001f\u007f]/.test(value);
  if (
    value.length === 0 ||
    value.length > MAX_ROUTE_PATH_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    hasControlCharacters
  ) {
    throw new ReviewError("INVALID_INPUT", "review route path is invalid");
  }
  return value.replace(/%[0-9a-fA-F]{2}/g, (encoded) => encoded.toUpperCase());
}

export function normalizeCommentBody(value: string): string {
  return normalizePlainTextBody(value, MAX_COMMENT_BODY_LENGTH, "review comment body");
}

export function normalizeReplyBody(value: string): string {
  return normalizePlainTextBody(value, MAX_REPLY_BODY_LENGTH, "review reply body");
}

export function extractMentionUsernames(body: string): readonly string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const pattern = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{2,63})/g;
  for (const match of body.matchAll(pattern)) {
    const username = match[2]!.toLowerCase();
    if (seen.has(username)) continue;
    seen.add(username);
    mentions.push(username);
  }
  if (mentions.length > MAX_MENTIONS_PER_BODY) {
    throw new ReviewError("INVALID_INPUT", "review content has too many mentions");
  }
  return mentions;
}

export function normalizeReviewUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw new ReviewError("INVALID_INPUT", "review username is invalid");
  }
  return username;
}

function normalizePlainTextBody(value: string, maxLength: number, name: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Review text allows line breaks but rejects the other ASCII control characters.
  const hasDisallowedControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized);
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    normalized.trim().length === 0 ||
    hasDisallowedControlCharacters
  ) {
    throw new ReviewError("INVALID_INPUT", `${name} is invalid`);
  }
  return normalized;
}

export function normalizeThreadStatusTransition(
  expectedStatus: ReviewThreadStatus,
  status: ReviewThreadStatus,
): Readonly<{ expectedStatus: ReviewThreadStatus; status: ReviewThreadStatus }> {
  if (
    (expectedStatus !== "OPEN" && expectedStatus !== "RESOLVED") ||
    (status !== "OPEN" && status !== "RESOLVED") ||
    expectedStatus === status
  ) {
    throw new ReviewError("INVALID_INPUT", "review thread status transition is invalid");
  }
  return { expectedStatus, status };
}

export function normalizeReviewEventCursor(value: string | undefined): string {
  const cursor = value ?? "0";
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(cursor)) {
    throw new ReviewError("INVALID_INPUT", "review event cursor is invalid");
  }
  if (BigInt(cursor) > 9_223_372_036_854_775_807n) {
    throw new ReviewError("INVALID_INPUT", "review event cursor is invalid");
  }
  return cursor;
}

export function encodeReviewPageCursor(value: ReviewPageCursor): string {
  const id = normalizeOpaqueReviewId(value.id, "review page cursor id");
  if (!(value.createdAt instanceof Date) || !Number.isFinite(value.createdAt.getTime())) {
    throw new ReviewError("INVALID_INPUT", "review page cursor timestamp is invalid");
  }
  return Buffer.from(JSON.stringify([value.createdAt.toISOString(), id]), "utf8").toString("base64url");
}

export function normalizeReviewPageCursor(value: string | undefined): ReviewPageCursor | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,384}$/.test(value)) {
    throw new ReviewError("INVALID_INPUT", "review page cursor is invalid");
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) {
      throw new Error("non-canonical cursor");
    }
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new ReviewError("INVALID_INPUT", "review page cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) throw new ReviewError("INVALID_INPUT", "review page cursor is invalid");
  const createdAt = new Date(parsed[0]);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== parsed[0]) {
    throw new ReviewError("INVALID_INPUT", "review page cursor is invalid");
  }
  const cursor = {
    createdAt,
    id: normalizeOpaqueReviewId(parsed[1], "review page cursor id"),
  };
  if (encodeReviewPageCursor(cursor) !== value) {
    throw new ReviewError("INVALID_INPUT", "review page cursor is invalid");
  }
  return cursor;
}

export function normalizePinNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewError("INVALID_INPUT", "review pin number is invalid");
  }
  return value;
}

export function normalizeReviewNotificationId(value: string): string {
  const id = normalizeReviewEventCursor(value);
  if (id === "0") {
    throw new ReviewError("INVALID_INPUT", "review notification id is invalid");
  }
  return id;
}

export function normalizeContentVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewError("INVALID_INPUT", "review content version is invalid");
  }
  return value;
}

export function canEditReviewContent(actor: ReviewActor, authorAccountId: string): boolean {
  return actor.capabilities.canComment && actor.accountId === authorAccountId;
}

export function canDeleteReviewContent(actor: ReviewActor, authorAccountId: string): boolean {
  return canEditReviewContent(actor, authorAccountId) || actor.capabilities.canManageProject;
}

export function normalizeOpaqueReviewId(value: string, name: string): string {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ReviewError("INVALID_INPUT", `${name} is invalid`);
  }
  return value;
}

export function normalizeAuthorizationVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewError("INVALID_INPUT", "authorization version is invalid");
  }
  return value;
}
