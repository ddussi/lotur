import type { OriginProjection } from "./session-config.ts";

export type HeaderPair = readonly [name: string, value: string];

export type HelloMetadata =
  | Readonly<{
      mode: "create";
      tunnelId: string;
      localOriginFingerprint: string;
      originProjection: OriginProjection;
    }>
  | Readonly<{
      mode: "resume";
      tunnelId: string;
      resumeSecret: string;
      localOriginFingerprint: string;
      originProjection: OriginProjection;
    }>;

export type SessionActiveMetadata = Readonly<{
  generation: number;
  tunnelId: string;
  shareUrl: string;
  readiness: Readonly<{
    carrier: true;
    config: true;
    origin: true;
    relay: true;
    route: true;
    admission: true;
  }>;
}>;

export type OpenHttpMetadata = Readonly<{
  kind: "HTTP" | "WEBSOCKET";
  method: string;
  path: string;
  headers: readonly HeaderPair[];
  requestBodyEnded: boolean;
  initialWindowBytes: number;
}>;

export type ResponseHeadersMetadata = Readonly<{
  statusCode: number;
  statusMessage: string;
  headers: readonly HeaderPair[];
}>;

export type ResetStreamMetadata = Readonly<{
  code: string;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const tunnelIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const methodPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function encodeMetadata(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeHelloMetadata(payload: Uint8Array): HelloMetadata {
  const value = parseObject(payload);
  if (value.mode !== "create" && value.mode !== "resume") {
    throw new TypeError("HELLO mode is invalid");
  }
  if (typeof value.tunnelId !== "string" || !tunnelIdPattern.test(value.tunnelId)) {
    throw new TypeError("HELLO tunnelId is invalid");
  }
  if (
    typeof value.localOriginFingerprint !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.localOriginFingerprint)
  ) {
    throw new TypeError("HELLO localOriginFingerprint is invalid");
  }
  if (value.originProjection !== "local-view" && value.originProjection !== "proxy-aware") {
    throw new TypeError("HELLO originProjection is invalid");
  }
  if (value.mode === "resume") {
    if (
      typeof value.resumeSecret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.resumeSecret)
    ) {
      throw new TypeError("HELLO resumeSecret is invalid");
    }
    return {
      mode: value.mode,
      tunnelId: value.tunnelId,
      resumeSecret: value.resumeSecret,
      localOriginFingerprint: value.localOriginFingerprint,
      originProjection: value.originProjection,
    };
  }
  return {
    mode: value.mode,
    tunnelId: value.tunnelId,
    localOriginFingerprint: value.localOriginFingerprint,
    originProjection: value.originProjection,
  };
}

export function decodeSessionActiveMetadata(
  payload: Uint8Array,
): SessionActiveMetadata {
  const value = parseObject(payload);
  if (
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation <= 0 ||
    value.generation > 0xffff_ffff
  ) {
    throw new TypeError("SESSION_ACTIVE generation is invalid");
  }
  if (typeof value.tunnelId !== "string" || !tunnelIdPattern.test(value.tunnelId)) {
    throw new TypeError("SESSION_ACTIVE tunnelId is invalid");
  }
  if (typeof value.shareUrl !== "string" || !isHttpUrl(value.shareUrl)) {
    throw new TypeError("SESSION_ACTIVE shareUrl is invalid");
  }
  const readiness = value.readiness;
  if (
    readiness === null ||
    typeof readiness !== "object" ||
    Array.isArray(readiness) ||
    !("carrier" in readiness) || readiness.carrier !== true ||
    !("config" in readiness) || readiness.config !== true ||
    !("origin" in readiness) || readiness.origin !== true ||
    !("relay" in readiness) || readiness.relay !== true ||
    !("route" in readiness) || readiness.route !== true ||
    !("admission" in readiness) || readiness.admission !== true
  ) {
    throw new TypeError("SESSION_ACTIVE readiness is invalid");
  }
  return {
    generation: value.generation,
    tunnelId: value.tunnelId,
    shareUrl: value.shareUrl,
    readiness: {
      carrier: true,
      config: true,
      origin: true,
      relay: true,
      route: true,
      admission: true,
    },
  };
}

export function decodeOpenHttpMetadata(payload: Uint8Array): OpenHttpMetadata {
  const value = parseObject(payload);
  if (value.kind !== "HTTP" && value.kind !== "WEBSOCKET") {
    throw new TypeError("OPEN_HTTP kind is invalid");
  }
  if (typeof value.method !== "string" || !methodPattern.test(value.method)) {
    throw new TypeError("OPEN_HTTP method is invalid");
  }
  if (
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    !/^[\x21-\x7e]+$/.test(value.path) ||
    value.path.includes("#")
  ) {
    throw new TypeError("OPEN_HTTP path is invalid");
  }
  if (typeof value.requestBodyEnded !== "boolean") {
    throw new TypeError("OPEN_HTTP requestBodyEnded is invalid");
  }
  if (
    typeof value.initialWindowBytes !== "number" ||
    !Number.isInteger(value.initialWindowBytes) ||
    value.initialWindowBytes <= 0 ||
    value.initialWindowBytes > 16 * 1024 * 1024
  ) {
    throw new TypeError("OPEN_HTTP initialWindowBytes is invalid");
  }
  return {
    kind: value.kind,
    method: value.method,
    path: value.path,
    headers: parseHeaders(value.headers),
    requestBodyEnded: value.requestBodyEnded,
    initialWindowBytes: value.initialWindowBytes,
  };
}

export function encodeWindowUpdate(bytes: number): Uint8Array {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 0xffff_ffff) {
    throw new RangeError("WINDOW_UPDATE bytes must be a positive uint32");
  }
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes);
  return payload;
}

export function decodeWindowUpdate(payload: Uint8Array): number {
  if (payload.byteLength !== 4) {
    throw new TypeError("WINDOW_UPDATE payload must be four bytes");
  }
  const bytes = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(0);
  if (bytes === 0) throw new TypeError("WINDOW_UPDATE bytes must be positive");
  return bytes;
}

export function decodeResponseHeadersMetadata(
  payload: Uint8Array,
): ResponseHeadersMetadata {
  const value = parseObject(payload);
  if (
    typeof value.statusCode !== "number" ||
    !Number.isInteger(value.statusCode) ||
    value.statusCode < 100 ||
    value.statusCode > 599
  ) {
    throw new TypeError("RESPONSE_HEADERS statusCode is invalid");
  }
  if (
    typeof value.statusMessage !== "string" ||
    /[\0\r\n]/.test(value.statusMessage)
  ) {
    throw new TypeError("RESPONSE_HEADERS statusMessage is invalid");
  }
  return {
    statusCode: value.statusCode,
    statusMessage: value.statusMessage,
    headers: parseHeaders(value.headers),
  };
}

export function decodeResetStreamMetadata(payload: Uint8Array): ResetStreamMetadata {
  const value = parseObject(payload);
  if (typeof value.code !== "string" || value.code.length === 0 || value.code.length > 64) {
    throw new TypeError("RESET_STREAM code is invalid");
  }
  return { code: value.code };
}

function parseObject(payload: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(decoder.decode(payload));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("metadata must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseHeaders(value: unknown): readonly HeaderPair[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError("header list is invalid");
  }
  return value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !headerNamePattern.test(entry[0]) ||
      /[\0\r\n]/.test(entry[1])
    ) {
      throw new TypeError("header pair is invalid");
    }
    return [entry[0], entry[1]] as const;
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
