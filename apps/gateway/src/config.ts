import type { SessionLimits } from "../../../packages/protocol/src/index.ts";
import { getDomain } from "tldts";

export type GatewayConfig = Readonly<{
  host: string;
  port: number;
  contentDomain: string;
  controlHost?: string;
  databaseUrl?: string;
  authSessionHmacKey?: Uint8Array;
  authSessionHmacPreviousKeys?: readonly Uint8Array[];
  secureCookies: boolean;
  autoMigrate: boolean;
  initialKillSwitch: boolean;
  gatewayAdmissionReady: boolean;
  metricsBearerToken?: string;
  sessionLimits?: Partial<SessionLimits>;
  heartbeatIntervalMs?: number;
  carrierLeaseMs?: number;
  authorizationMaxAgeMs?: number;
  authorizationCheckIntervalMs?: number;
}>;

export function readGatewayConfig(
  environment: Readonly<Record<string, string | undefined>>,
): GatewayConfig {
  const host = environment.GATEWAY_HOST ?? "127.0.0.1";
  const port = parsePort(environment.GATEWAY_PORT ?? "8787");
  const contentDomain = parseDomain(environment.CONTENT_DOMAIN ?? "localhost");
  const insecureExternalPoc = environment.ALLOW_INSECURE_POC === "true";
  const databaseUrl = environment.DATABASE_URL;
  const controlHost = environment.CONTROL_HOST;
  const authSessionHmacKeyText = environment.AUTH_SESSION_HMAC_KEY;
  const previousHmacKeyText = environment.AUTH_SESSION_HMAC_KEY_PREVIOUS;
  const insecureHttpAuth = environment.ALLOW_INSECURE_HTTP_AUTH === "true";
  const metricsBearerToken = environment.METRICS_BEARER_TOKEN;
  const sessionLimits = compactSessionLimits(environment);
  const heartbeatIntervalMs = optionalPositiveInteger(environment.HEARTBEAT_INTERVAL_MS, "HEARTBEAT_INTERVAL_MS");
  const carrierLeaseMs = optionalPositiveInteger(environment.CARRIER_LEASE_MS, "CARRIER_LEASE_MS");
  const authorizationMaxAgeMs = optionalPositiveInteger(
    environment.AUTHORIZATION_MAX_AGE_MS,
    "AUTHORIZATION_MAX_AGE_MS",
  );
  const authorizationCheckIntervalMs = optionalPositiveInteger(
    environment.REVOCATION_CHECK_INTERVAL_MS,
    "REVOCATION_CHECK_INTERVAL_MS",
  );
  const gatewayAdmissionReady = environment.GATEWAY_ADMISSION_READY === "true" ||
    (databaseUrl === undefined && isLoopbackBindHost(host));
  if (
    (carrierLeaseMs ?? 45_000) <= (heartbeatIntervalMs ?? 15_000)
  ) {
    throw new Error("CARRIER_LEASE_MS must be greater than HEARTBEAT_INTERVAL_MS");
  }

  if (!isLoopbackBindHost(host) && databaseUrl === undefined && !insecureExternalPoc) {
    throw new Error(
      "인증 없는 Phase 1 POC는 loopback에만 바인딩됩니다. 외부 바인딩은 보안 MVP에서 구성하세요.",
    );
  }

  if (databaseUrl !== undefined && (controlHost === undefined || authSessionHmacKeyText === undefined)) {
    throw new Error("DATABASE_URL auth mode requires CONTROL_HOST and AUTH_SESSION_HMAC_KEY");
  }
  if (databaseUrl === undefined && (controlHost !== undefined || authSessionHmacKeyText !== undefined)) {
    throw new Error("DATABASE_URL, CONTROL_HOST and AUTH_SESSION_HMAC_KEY must be configured together");
  }
  if (previousHmacKeyText !== undefined && authSessionHmacKeyText === undefined) {
    throw new Error("AUTH_SESSION_HMAC_KEY_PREVIOUS requires AUTH_SESSION_HMAC_KEY");
  }
  let authSessionHmacKey: Uint8Array | undefined;
  if (authSessionHmacKeyText !== undefined) {
    authSessionHmacKey = decodeHmacKey(authSessionHmacKeyText, "AUTH_SESSION_HMAC_KEY");
  }
  const authSessionHmacPreviousKeys = previousHmacKeyText === undefined
    ? []
    : previousHmacKeyText
      .split(",")
      .map((value, index) =>
        decodeHmacKey(value.trim(), `AUTH_SESSION_HMAC_KEY_PREVIOUS[${index}]`)
      );
  if (controlHost !== undefined) {
    const normalizedControlHost = parseDomain(controlHost);
    if (siteBoundary(normalizedControlHost) === siteBoundary(contentDomain)) {
      throw new Error("CONTROL_HOST and CONTENT_DOMAIN must use different browser site boundaries");
    }
  }
  if (insecureHttpAuth && !isLoopbackBindHost(host)) {
    throw new Error("ALLOW_INSECURE_HTTP_AUTH is only allowed on a loopback bind");
  }
  if (metricsBearerToken !== undefined && metricsBearerToken.length < 32) {
    throw new Error("METRICS_BEARER_TOKEN must contain at least 32 characters");
  }

  return {
    host,
    port,
    contentDomain,
    secureCookies: databaseUrl !== undefined && !insecureHttpAuth,
    autoMigrate: environment.AUTO_MIGRATE !== "false",
    initialKillSwitch: environment.KILL_SWITCH_ENABLED === "true",
    gatewayAdmissionReady,
    ...(metricsBearerToken === undefined ? {} : { metricsBearerToken }),
    ...(Object.keys(sessionLimits).length === 0 ? {} : { sessionLimits }),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    ...(carrierLeaseMs === undefined ? {} : { carrierLeaseMs }),
    ...(authorizationMaxAgeMs === undefined ? {} : { authorizationMaxAgeMs }),
    ...(authorizationCheckIntervalMs === undefined
      ? {}
      : { authorizationCheckIntervalMs }),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(controlHost === undefined ? {} : { controlHost: parseDomain(controlHost) }),
    ...(authSessionHmacKey === undefined ? {} : { authSessionHmacKey }),
    ...(authSessionHmacPreviousKeys.length === 0
      ? {}
      : { authSessionHmacPreviousKeys }),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("GATEWAY_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function decodeHmacKey(value: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must be base64url without padding`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 32) {
    throw new Error(`${name} must decode to at least 32 bytes`);
  }
  return decoded;
}

function compactSessionLimits(
  environment: Readonly<Record<string, string | undefined>>,
): Partial<SessionLimits> {
  const mappings = [
    ["maxRequestBodyBytes", "MAX_REQUEST_BODY_BYTES"],
    ["maxFiniteResponseBytes", "MAX_FINITE_RESPONSE_BYTES"],
    ["maxConcurrentStreams", "MAX_CONCURRENT_STREAMS"],
    ["maxNewStreamsPerMinute", "MAX_NEW_STREAMS_PER_MINUTE"],
    ["responseHeaderTimeoutMs", "RESPONSE_HEADER_TIMEOUT_MS"],
    ["streamInactivityTimeoutMs", "STREAM_INACTIVITY_TIMEOUT_MS"],
    ["maxStreamDurationMs", "MAX_STREAM_DURATION_MS"],
  ] as const;
  const limits: Partial<Record<keyof SessionLimits, number>> = {};
  for (const [property, environmentName] of mappings) {
    const parsed = optionalPositiveInteger(environment[environmentName], environmentName);
    if (parsed !== undefined) limits[property] = parsed;
  }
  return limits;
}

function parseDomain(value: string): string {
  const normalized = value.toLowerCase().replace(/\.$/, "");
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes("://") ||
    !/^[a-z0-9.-]+$/.test(normalized) ||
    normalized.split(".").some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-"),
    )
  ) {
    throw new TypeError("CONTENT_DOMAIN must be a DNS hostname without scheme or wildcard");
  }
  return normalized;
}

function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function siteBoundary(hostname: string): string {
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}
