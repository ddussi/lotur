import { createHash } from "node:crypto";

import {
  DEFAULT_SESSION_POLICY,
  type SessionPolicy,
} from "./session-policy.ts";

export const CARRIER_PROFILE = "review-tunnel.v1";
export const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;

export type SessionLimits = Readonly<{
  maxRequestBodyBytes: number;
  maxFiniteResponseBytes: number;
  maxConcurrentStreams: number;
  maxNewStreamsPerMinute: number;
  responseHeaderTimeoutMs: number;
  streamInactivityTimeoutMs: number;
  maxStreamDurationMs: number;
}>;

export const DEFAULT_SESSION_LIMITS: SessionLimits = Object.freeze({
  maxRequestBodyBytes: 16 * 1024 * 1024,
  maxFiniteResponseBytes: 64 * 1024 * 1024,
  maxConcurrentStreams: 128,
  maxNewStreamsPerMinute: 600,
  responseHeaderTimeoutMs: 10_000,
  streamInactivityTimeoutMs: 2 * 60_000,
  maxStreamDurationMs: 4 * 60 * 60_000,
});

export type OriginProjection = "local-view" | "proxy-aware";

export type SessionConfigSnapshot = Readonly<{
  profile: typeof CARRIER_PROFILE;
  generation: number;
  localOriginFingerprint: string;
  originProjection: OriginProjection;
  publicOrigin: string;
  initialConnectionWindowBytes: number;
  initialStreamWindowBytes: number;
  maxTtlMs: number;
  idleTimeoutMs: number;
  reconnectGraceMs: number;
  maxRequestBodyBytes: number;
  maxFiniteResponseBytes: number;
  maxConcurrentStreams: number;
  maxNewStreamsPerMinute: number;
  responseHeaderTimeoutMs: number;
  streamInactivityTimeoutMs: number;
  maxStreamDurationMs: number;
}>;

export type SessionConfigMetadata = Readonly<{
  revision: number;
  digest: string;
  snapshot: SessionConfigSnapshot;
}>;

export type SessionProvisionedMetadata = Readonly<{
  sessionId: string;
  provisionId: string;
  tunnelId: string;
  shareUrl: string;
  resumeSecret: string;
}>;

export type ConfigAppliedMetadata = Readonly<{
  revision: number;
  digest: string;
  result: "APPLIED" | "REJECTED";
  localOriginReady: boolean;
  provisionReceipt?: string;
}>;

export type OpenProbeMetadata = Readonly<{
  initialWindowBytes: number;
}>;

export type ConnectionErrorCode =
  | "VERSION_UNSUPPORTED"
  | "AUTH_FAILED"
  | "RESUME_REJECTED"
  | "RESUME_IN_PROGRESS"
  | "SESSION_NOT_FOUND"
  | "PROVISION_RECEIPT_FAILED"
  | "CONFIG_APPLY_FAILED"
  | "CONFIG_ACK_TIMEOUT"
  | "LOCAL_ORIGIN_UNAVAILABLE"
  | "RELAY_NOT_READY"
  | "ACTIVATION_TIMEOUT"
  | "PROTOCOL_ERROR"
  | "FLOW_CONTROL_ERROR";

export type ConnectionErrorMetadata = Readonly<{
  code: ConnectionErrorCode;
  retryAfterMs?: number;
}>;

const connectionErrorCodes = new Set<ConnectionErrorCode>([
  "VERSION_UNSUPPORTED",
  "AUTH_FAILED",
  "RESUME_REJECTED",
  "RESUME_IN_PROGRESS",
  "SESSION_NOT_FOUND",
  "PROVISION_RECEIPT_FAILED",
  "CONFIG_APPLY_FAILED",
  "CONFIG_ACK_TIMEOUT",
  "LOCAL_ORIGIN_UNAVAILABLE",
  "RELAY_NOT_READY",
  "ACTIVATION_TIMEOUT",
  "PROTOCOL_ERROR",
  "FLOW_CONTROL_ERROR",
]);

export function createSessionConfigSnapshot(input: Readonly<{
  generation: number;
  localOriginFingerprint: string;
  originProjection: OriginProjection;
  publicOrigin: string;
  initialConnectionWindowBytes: number;
  initialStreamWindowBytes: number;
  policy?: SessionPolicy;
  limits?: SessionLimits;
}>): SessionConfigSnapshot {
  const policy = input.policy ?? DEFAULT_SESSION_POLICY;
  const limits = input.limits ?? DEFAULT_SESSION_LIMITS;
  const snapshot: SessionConfigSnapshot = {
    profile: CARRIER_PROFILE,
    generation: input.generation,
    localOriginFingerprint: input.localOriginFingerprint,
    originProjection: input.originProjection,
    publicOrigin: input.publicOrigin,
    initialConnectionWindowBytes: input.initialConnectionWindowBytes,
    initialStreamWindowBytes: input.initialStreamWindowBytes,
    maxTtlMs: policy.maxTtlMs,
    idleTimeoutMs: policy.idleTimeoutMs,
    reconnectGraceMs: policy.reconnectGraceMs,
    maxRequestBodyBytes: limits.maxRequestBodyBytes,
    maxFiniteResponseBytes: limits.maxFiniteResponseBytes,
    maxConcurrentStreams: limits.maxConcurrentStreams,
    maxNewStreamsPerMinute: limits.maxNewStreamsPerMinute,
    responseHeaderTimeoutMs: limits.responseHeaderTimeoutMs,
    streamInactivityTimeoutMs: limits.streamInactivityTimeoutMs,
    maxStreamDurationMs: limits.maxStreamDurationMs,
  };
  assertSessionConfigSnapshot(snapshot);
  return Object.freeze(snapshot);
}

export function encodeCanonicalSessionConfig(
  snapshot: SessionConfigSnapshot,
): Uint8Array {
  assertSessionConfigSnapshot(snapshot);
  return new TextEncoder().encode(JSON.stringify({
    generation: snapshot.generation,
    idleTimeoutMs: snapshot.idleTimeoutMs,
    initialConnectionWindowBytes: snapshot.initialConnectionWindowBytes,
    initialStreamWindowBytes: snapshot.initialStreamWindowBytes,
    localOriginFingerprint: snapshot.localOriginFingerprint,
    maxConcurrentStreams: snapshot.maxConcurrentStreams,
    maxFiniteResponseBytes: snapshot.maxFiniteResponseBytes,
    maxNewStreamsPerMinute: snapshot.maxNewStreamsPerMinute,
    maxRequestBodyBytes: snapshot.maxRequestBodyBytes,
    maxStreamDurationMs: snapshot.maxStreamDurationMs,
    maxTtlMs: snapshot.maxTtlMs,
    originProjection: snapshot.originProjection,
    profile: snapshot.profile,
    publicOrigin: snapshot.publicOrigin,
    reconnectGraceMs: snapshot.reconnectGraceMs,
    responseHeaderTimeoutMs: snapshot.responseHeaderTimeoutMs,
    streamInactivityTimeoutMs: snapshot.streamInactivityTimeoutMs,
  }));
}

export function digestSessionConfig(snapshot: SessionConfigSnapshot): string {
  return createHash("sha256")
    .update(encodeCanonicalSessionConfig(snapshot))
    .digest("base64url");
}

export function assertSessionConfigMetadata(
  metadata: SessionConfigMetadata,
): void {
  assertPositiveUint32(metadata.revision, "revision");
  assertDigest(metadata.digest, "digest");
  assertSessionConfigSnapshot(metadata.snapshot);
  if (digestSessionConfig(metadata.snapshot) !== metadata.digest) {
    throw new TypeError("SESSION_CONFIG digest does not match snapshot");
  }
}

export function assertSessionConfigSnapshot(
  snapshot: SessionConfigSnapshot,
): void {
  if (snapshot.profile !== CARRIER_PROFILE) {
    throw new TypeError("SESSION_CONFIG profile is unsupported");
  }
  assertPositiveUint32(snapshot.generation, "generation");
  assertDigest(snapshot.localOriginFingerprint, "localOriginFingerprint");
  if (
    snapshot.originProjection !== "local-view" &&
    snapshot.originProjection !== "proxy-aware"
  ) {
    throw new TypeError("SESSION_CONFIG originProjection is invalid");
  }
  assertOrigin(snapshot.publicOrigin, "SESSION_CONFIG publicOrigin");
  assertBoundedPositiveInteger(
    snapshot.initialConnectionWindowBytes,
    "initialConnectionWindowBytes",
    64 * 1024 * 1024,
  );
  assertBoundedPositiveInteger(
    snapshot.initialStreamWindowBytes,
    "initialStreamWindowBytes",
    16 * 1024 * 1024,
  );
  assertBoundedPositiveInteger(snapshot.maxTtlMs, "maxTtlMs", 7 * 24 * 60 * 60_000);
  assertBoundedPositiveInteger(snapshot.idleTimeoutMs, "idleTimeoutMs", snapshot.maxTtlMs);
  assertBoundedPositiveInteger(
    snapshot.reconnectGraceMs,
    "reconnectGraceMs",
    snapshot.maxTtlMs,
  );
  assertBoundedPositiveInteger(
    snapshot.maxRequestBodyBytes,
    "maxRequestBodyBytes",
    1024 * 1024 * 1024,
  );
  assertBoundedPositiveInteger(
    snapshot.maxFiniteResponseBytes,
    "maxFiniteResponseBytes",
    1024 * 1024 * 1024,
  );
  assertBoundedPositiveInteger(snapshot.maxConcurrentStreams, "maxConcurrentStreams", 10_000);
  assertBoundedPositiveInteger(
    snapshot.maxNewStreamsPerMinute,
    "maxNewStreamsPerMinute",
    100_000,
  );
  assertBoundedPositiveInteger(
    snapshot.responseHeaderTimeoutMs,
    "responseHeaderTimeoutMs",
    10 * 60_000,
  );
  assertBoundedPositiveInteger(
    snapshot.streamInactivityTimeoutMs,
    "streamInactivityTimeoutMs",
    24 * 60 * 60_000,
  );
  assertBoundedPositiveInteger(
    snapshot.maxStreamDurationMs,
    "maxStreamDurationMs",
    snapshot.maxTtlMs,
  );
}

export function decodeSessionProvisionedMetadata(
  payload: Uint8Array,
): SessionProvisionedMetadata {
  const value = parseObject(payload);
  assertOpaqueId(value.sessionId, "SESSION_PROVISIONED sessionId");
  assertOpaqueId(value.provisionId, "SESSION_PROVISIONED provisionId");
  assertTunnelId(value.tunnelId, "SESSION_PROVISIONED tunnelId");
  assertHttpUrl(value.shareUrl, "SESSION_PROVISIONED shareUrl");
  assertSecret(value.resumeSecret, "SESSION_PROVISIONED resumeSecret");
  return {
    sessionId: value.sessionId,
    provisionId: value.provisionId,
    tunnelId: value.tunnelId,
    shareUrl: value.shareUrl,
    resumeSecret: value.resumeSecret,
  };
}

export function decodeSessionConfigMetadata(payload: Uint8Array): SessionConfigMetadata {
  const value = parseObject(payload);
  if (typeof value.revision !== "number") {
    throw new TypeError("SESSION_CONFIG revision is invalid");
  }
  if (typeof value.digest !== "string") {
    throw new TypeError("SESSION_CONFIG digest is invalid");
  }
  const snapshot = parseSessionConfigSnapshot(value.snapshot);
  const metadata = { revision: value.revision, digest: value.digest, snapshot };
  assertSessionConfigMetadata(metadata);
  return metadata;
}

export function decodeConfigAppliedMetadata(payload: Uint8Array): ConfigAppliedMetadata {
  const value = parseObject(payload);
  if (typeof value.revision !== "number") {
    throw new TypeError("CONFIG_APPLIED revision is invalid");
  }
  assertPositiveUint32(value.revision, "CONFIG_APPLIED revision");
  if (typeof value.digest !== "string") {
    throw new TypeError("CONFIG_APPLIED digest is invalid");
  }
  assertDigest(value.digest, "CONFIG_APPLIED digest");
  if (value.result !== "APPLIED" && value.result !== "REJECTED") {
    throw new TypeError("CONFIG_APPLIED result is invalid");
  }
  if (typeof value.localOriginReady !== "boolean") {
    throw new TypeError("CONFIG_APPLIED localOriginReady is invalid");
  }
  if (value.provisionReceipt !== undefined) {
    assertOpaqueId(value.provisionReceipt, "CONFIG_APPLIED provisionReceipt");
  }
  return {
    revision: value.revision,
    digest: value.digest,
    result: value.result,
    localOriginReady: value.localOriginReady,
    ...(value.provisionReceipt === undefined
      ? {}
      : { provisionReceipt: value.provisionReceipt }),
  };
}

export function decodeOpenProbeMetadata(payload: Uint8Array): OpenProbeMetadata {
  const value = parseObject(payload);
  if (typeof value.initialWindowBytes !== "number") {
    throw new TypeError("OPEN_PROBE initialWindowBytes is invalid");
  }
  assertBoundedPositiveInteger(
    value.initialWindowBytes,
    "OPEN_PROBE initialWindowBytes",
    16 * 1024 * 1024,
  );
  return { initialWindowBytes: value.initialWindowBytes };
}

export function decodeConnectionErrorMetadata(
  payload: Uint8Array,
): ConnectionErrorMetadata {
  const value = parseObject(payload);
  if (typeof value.code !== "string" || !connectionErrorCodes.has(value.code as ConnectionErrorCode)) {
    throw new TypeError("CONNECTION_ERROR code is invalid");
  }
  if (value.retryAfterMs !== undefined) {
    if (
      value.code !== "RESUME_IN_PROGRESS" ||
      typeof value.retryAfterMs !== "number" ||
      !Number.isInteger(value.retryAfterMs) ||
      value.retryAfterMs < 100 ||
      value.retryAfterMs > 5_000
    ) {
      throw new TypeError("CONNECTION_ERROR retryAfterMs is invalid");
    }
  }
  return {
    code: value.code as ConnectionErrorCode,
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }),
  };
}

function parseSessionConfigSnapshot(value: unknown): SessionConfigSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SESSION_CONFIG snapshot is invalid");
  }
  const record = value as Record<string, unknown>;
  const snapshot = {
    profile: record.profile,
    generation: record.generation,
    localOriginFingerprint: record.localOriginFingerprint,
    originProjection: record.originProjection,
    publicOrigin: record.publicOrigin,
    initialConnectionWindowBytes: record.initialConnectionWindowBytes,
    initialStreamWindowBytes: record.initialStreamWindowBytes,
    maxTtlMs: record.maxTtlMs,
    idleTimeoutMs: record.idleTimeoutMs,
    reconnectGraceMs: record.reconnectGraceMs,
    maxRequestBodyBytes: record.maxRequestBodyBytes,
    maxFiniteResponseBytes: record.maxFiniteResponseBytes,
    maxConcurrentStreams: record.maxConcurrentStreams,
    maxNewStreamsPerMinute: record.maxNewStreamsPerMinute,
    responseHeaderTimeoutMs: record.responseHeaderTimeoutMs,
    streamInactivityTimeoutMs: record.streamInactivityTimeoutMs,
    maxStreamDurationMs: record.maxStreamDurationMs,
  } as SessionConfigSnapshot;
  assertSessionConfigSnapshot(snapshot);
  return snapshot;
}

function parseObject(payload: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("metadata must be an object");
  }
  return parsed as Record<string, unknown>;
}

function assertOpaqueId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertTunnelId(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertSecret(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertHttpUrl(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertOrigin(value: unknown, name: string): asserts value is string {
  assertHttpUrl(value, name);
  const url = new URL(value);
  if (url.origin !== value || url.pathname !== "/" || url.search !== "") {
    throw new TypeError(`${name} must be a canonical HTTP origin`);
  }
}

function assertDigest(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError(`${name} must be a SHA-256 base64url digest`);
  }
}

function assertPositiveUint32(value: number, name: string): void {
  assertBoundedPositiveInteger(value, name, 0xffff_ffff);
}

function assertBoundedPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
}
