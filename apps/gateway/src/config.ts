import type { SessionLimits } from "../../../packages/protocol/src/index.ts";
import {
  DEFAULT_AUDIT_EVENT_LIMITS,
  DEFAULT_LOGIN_THROTTLE_LIMITS,
} from "../../../packages/auth/src/index.ts";
import {
  parseDeploymentIdentity,
  type DeploymentIdentity,
} from "../../../packages/operations/src/index.ts";
import { createClientAddressResolver } from "./client-address.ts";
import { parsePublicContentOrigin } from "./public-content-origin.ts";

export type GatewayConfig = Readonly<{
  host: string;
  port: number;
  contentDomain: string;
  publicContentOrigin?: string;
  controlHost?: string;
  databaseUrl?: string;
  authSessionHmacKey?: Uint8Array;
  authSessionHmacPreviousKeys?: readonly Uint8Array[];
  secureCookies: boolean;
  autoMigrate: boolean;
  initialKillSwitch: boolean;
  gatewayAdmissionReady: boolean;
  metricsBearerToken?: string;
  canaryHost?: string;
  canaryBearerToken?: string;
  sessionLimits?: Partial<SessionLimits>;
  heartbeatIntervalMs?: number;
  carrierLeaseMs?: number;
  authorizationMaxAgeMs?: number;
  authorizationCheckIntervalMs?: number;
  deploymentIdentity?: DeploymentIdentity;
  operationalStatePollIntervalMs?: number;
  databaseConnectionTimeoutMs?: number;
  databaseQueryTimeoutMs?: number;
  maxPendingTunnels?: number;
  maxActiveTunnels?: number;
  maxTunnelsPerAccount?: number;
  loginIntentsPerSourcePerMinute?: number;
  loginIntentsGlobalPerMinute?: number;
  maxConcurrentLoginAttempts?: number;
  maxConcurrentLoginAttemptsPerRemote?: number;
  loginAttemptsPerMinute?: number;
  loginAttemptsPerRemotePerMinute?: number;
  maxConcurrentWebAuthorizations?: number;
  maxConcurrentWebAuthorizationsPerRemote?: number;
  trustedProxyCidrs?: readonly string[];
  maxForwardedForEntries?: number;
  maxOutstandingCarrierCredentials?: number;
  maxOutstandingCarrierCredentialsPerAccount?: number;
  carrierCredentialsPerMinute?: number;
  carrierCredentialsPerAccountPerMinute?: number;
  maxAuthSessions?: number;
  maxAuthSessionsPerAccount?: number;
  maxSessionExchanges?: number;
  maxSessionExchangesPerAccount?: number;
  maxLoginThrottles?: number;
  maxAuditEvents?: number;
  auditOperationalReserve?: number;
  maxPendingCarrierFrames?: number;
  maxPendingCarrierBytes?: number;
  maxCanaryWebSockets?: number;
  canaryWebSocketIdleTimeoutMs?: number;
}>;

const MAX_NODE_TIMER_MS = 2_147_483_647;
const MAX_SESSION_HMAC_KEY_BYTES = 128;
const MAX_PREVIOUS_SESSION_HMAC_KEYS = 3;

export function readGatewayConfig(
  environment: Readonly<Record<string, string | undefined>>,
): GatewayConfig {
  const host = environment.GATEWAY_HOST ?? "127.0.0.1";
  const port = parsePort(environment.GATEWAY_PORT ?? "8787");
  const contentDomain = parseDomain(environment.CONTENT_DOMAIN ?? "localhost");
  const publicContentOriginText = environment.PUBLIC_CONTENT_ORIGIN;
  const insecureExternalPoc = strictBoolean(
    environment.ALLOW_INSECURE_POC,
    "ALLOW_INSECURE_POC",
    false,
  );
  const databaseUrl = environment.DATABASE_URL;
  const controlHost = environment.CONTROL_HOST;
  const authSessionHmacKeyText = environment.AUTH_SESSION_HMAC_KEY;
  const previousHmacKeyText = environment.AUTH_SESSION_HMAC_KEY_PREVIOUS;
  const insecureHttpAuth = strictBoolean(
    environment.ALLOW_INSECURE_HTTP_AUTH,
    "ALLOW_INSECURE_HTTP_AUTH",
    false,
  );
  const metricsBearerToken = environment.METRICS_BEARER_TOKEN;
  const canaryHostText = environment.CANARY_HOST;
  const canaryBearerToken = environment.CANARY_BEARER_TOKEN;
  const sessionLimits = compactSessionLimits(environment);
  const heartbeatIntervalMs = optionalBoundedPositiveInteger(
    environment.HEARTBEAT_INTERVAL_MS,
    "HEARTBEAT_INTERVAL_MS",
    MAX_NODE_TIMER_MS,
  );
  const carrierLeaseMs = optionalBoundedPositiveInteger(
    environment.CARRIER_LEASE_MS,
    "CARRIER_LEASE_MS",
    MAX_NODE_TIMER_MS,
  );
  const authorizationMaxAgeMs = optionalBoundedPositiveInteger(
    environment.AUTHORIZATION_MAX_AGE_MS,
    "AUTHORIZATION_MAX_AGE_MS",
    MAX_NODE_TIMER_MS,
  );
  const authorizationCheckIntervalMs = optionalBoundedPositiveInteger(
    environment.REVOCATION_CHECK_INTERVAL_MS,
    "REVOCATION_CHECK_INTERVAL_MS",
    MAX_NODE_TIMER_MS,
  );
  const operationalStatePollIntervalMs = optionalBoundedPositiveInteger(
    environment.OPERATIONAL_STATE_POLL_INTERVAL_MS,
    "OPERATIONAL_STATE_POLL_INTERVAL_MS",
    MAX_NODE_TIMER_MS,
  );
  const databaseConnectionTimeoutMs = optionalBoundedPositiveInteger(
    environment.DATABASE_CONNECT_TIMEOUT_MS,
    "DATABASE_CONNECT_TIMEOUT_MS",
    MAX_NODE_TIMER_MS,
  );
  const databaseQueryTimeoutMs = optionalBoundedPositiveInteger(
    environment.DATABASE_QUERY_TIMEOUT_MS,
    "DATABASE_QUERY_TIMEOUT_MS",
    MAX_NODE_TIMER_MS,
  );
  const maxPendingTunnels = optionalBoundedPositiveInteger(
    environment.MAX_PENDING_TUNNELS,
    "MAX_PENDING_TUNNELS",
    100_000,
  );
  const maxActiveTunnels = optionalBoundedPositiveInteger(
    environment.MAX_ACTIVE_TUNNELS,
    "MAX_ACTIVE_TUNNELS",
    100_000,
  );
  const maxTunnelsPerAccount = optionalBoundedPositiveInteger(
    environment.MAX_TUNNELS_PER_ACCOUNT,
    "MAX_TUNNELS_PER_ACCOUNT",
    10_000,
  );
  const loginIntentsPerSourcePerMinute = optionalBoundedPositiveInteger(
    environment.LOGIN_INTENTS_PER_SOURCE_PER_MINUTE,
    "LOGIN_INTENTS_PER_SOURCE_PER_MINUTE",
    100_000,
  );
  const loginIntentsGlobalPerMinute = optionalBoundedPositiveInteger(
    environment.LOGIN_INTENTS_GLOBAL_PER_MINUTE,
    "LOGIN_INTENTS_GLOBAL_PER_MINUTE",
    1_000_000,
  );
  const maxConcurrentLoginAttempts = optionalBoundedPositiveInteger(
    environment.MAX_CONCURRENT_LOGIN_ATTEMPTS,
    "MAX_CONCURRENT_LOGIN_ATTEMPTS",
    10_000,
  );
  const maxConcurrentLoginAttemptsPerRemote = optionalBoundedPositiveInteger(
    environment.MAX_CONCURRENT_LOGIN_ATTEMPTS_PER_REMOTE,
    "MAX_CONCURRENT_LOGIN_ATTEMPTS_PER_REMOTE",
    1_000,
  );
  const loginAttemptsPerMinute = optionalBoundedPositiveInteger(
    environment.LOGIN_ATTEMPTS_PER_MINUTE,
    "LOGIN_ATTEMPTS_PER_MINUTE",
    1_000_000,
  );
  const loginAttemptsPerRemotePerMinute = optionalBoundedPositiveInteger(
    environment.LOGIN_ATTEMPTS_PER_REMOTE_PER_MINUTE,
    "LOGIN_ATTEMPTS_PER_REMOTE_PER_MINUTE",
    100_000,
  );
  const maxConcurrentWebAuthorizations = optionalBoundedPositiveInteger(
    environment.MAX_CONCURRENT_WEB_AUTHORIZATIONS,
    "MAX_CONCURRENT_WEB_AUTHORIZATIONS",
    10_000,
  );
  const maxConcurrentWebAuthorizationsPerRemote = optionalBoundedPositiveInteger(
    environment.MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE,
    "MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE",
    1_000,
  );
  const trustedProxyCidrs = optionalTrustedProxyCidrs(environment.TRUSTED_PROXY_CIDRS);
  const maxForwardedForEntries = optionalBoundedPositiveInteger(
    environment.MAX_FORWARDED_FOR_ENTRIES,
    "MAX_FORWARDED_FOR_ENTRIES",
    64,
  );
  if (maxForwardedForEntries !== undefined && trustedProxyCidrs === undefined) {
    throw new TypeError("MAX_FORWARDED_FOR_ENTRIES requires TRUSTED_PROXY_CIDRS");
  }
  const maxOutstandingCarrierCredentials = optionalBoundedPositiveInteger(
    environment.MAX_OUTSTANDING_CARRIER_CREDENTIALS,
    "MAX_OUTSTANDING_CARRIER_CREDENTIALS",
    100_000,
  );
  const maxOutstandingCarrierCredentialsPerAccount = optionalBoundedPositiveInteger(
    environment.MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT,
    "MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT",
    10_000,
  );
  const carrierCredentialsPerMinute = optionalBoundedPositiveInteger(
    environment.CARRIER_CREDENTIALS_PER_MINUTE,
    "CARRIER_CREDENTIALS_PER_MINUTE",
    1_000_000,
  );
  const carrierCredentialsPerAccountPerMinute = optionalBoundedPositiveInteger(
    environment.CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE,
    "CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE",
    100_000,
  );
  const maxAuthSessions = optionalBoundedPositiveInteger(
    environment.MAX_AUTH_SESSIONS,
    "MAX_AUTH_SESSIONS",
    10_000_000,
  );
  const maxAuthSessionsPerAccount = optionalBoundedPositiveInteger(
    environment.MAX_AUTH_SESSIONS_PER_ACCOUNT,
    "MAX_AUTH_SESSIONS_PER_ACCOUNT",
    1_000_000,
  );
  const maxSessionExchanges = optionalBoundedPositiveInteger(
    environment.MAX_SESSION_EXCHANGES,
    "MAX_SESSION_EXCHANGES",
    10_000_000,
  );
  const maxSessionExchangesPerAccount = optionalBoundedPositiveInteger(
    environment.MAX_SESSION_EXCHANGES_PER_ACCOUNT,
    "MAX_SESSION_EXCHANGES_PER_ACCOUNT",
    1_000_000,
  );
  const maxLoginThrottles = optionalBoundedPositiveInteger(
    environment.MAX_LOGIN_THROTTLES,
    "MAX_LOGIN_THROTTLES",
    10_000_000,
  );
  const maxAuditEvents = optionalBoundedPositiveInteger(
    environment.MAX_AUDIT_EVENTS,
    "MAX_AUDIT_EVENTS",
    100_000_000,
  );
  const auditOperationalReserve = optionalBoundedPositiveInteger(
    environment.AUDIT_OPERATIONAL_RESERVE,
    "AUDIT_OPERATIONAL_RESERVE",
    10_000_000,
  );
  const maxPendingCarrierFrames = optionalBoundedPositiveInteger(
    environment.MAX_PENDING_CARRIER_FRAMES,
    "MAX_PENDING_CARRIER_FRAMES",
    10_000,
  );
  const maxPendingCarrierBytes = optionalBoundedPositiveInteger(
    environment.MAX_PENDING_CARRIER_BYTES,
    "MAX_PENDING_CARRIER_BYTES",
    1024 * 1024 * 1024,
  );
  const maxCanaryWebSockets = optionalBoundedPositiveInteger(
    environment.MAX_CANARY_WEBSOCKETS,
    "MAX_CANARY_WEBSOCKETS",
    10_000,
  );
  const canaryWebSocketIdleTimeoutMs = optionalBoundedPositiveInteger(
    environment.CANARY_WEBSOCKET_IDLE_TIMEOUT_MS,
    "CANARY_WEBSOCKET_IDLE_TIMEOUT_MS",
    MAX_NODE_TIMER_MS,
  );
  const deploymentId = environment.DEPLOYMENT_ID;
  const deploymentConfigDigest = environment.DEPLOYMENT_CONFIG_DIGEST;
  const gatewayAdmissionReady = databaseUrl === undefined &&
    (strictBoolean(
      environment.GATEWAY_ADMISSION_READY,
      "GATEWAY_ADMISSION_READY",
      false,
    ) || isLoopbackBindHost(host));
  if (
    (carrierLeaseMs ?? 45_000) <= (heartbeatIntervalMs ?? 15_000)
  ) {
    throw new Error("CARRIER_LEASE_MS must be greater than HEARTBEAT_INTERVAL_MS");
  }
  assertSubLimit(
    maxAuthSessionsPerAccount ?? 64,
    maxAuthSessions ?? 100_000,
    "MAX_AUTH_SESSIONS_PER_ACCOUNT",
    "MAX_AUTH_SESSIONS",
  );
  assertSubLimit(
    maxSessionExchangesPerAccount ?? 256,
    maxSessionExchanges ?? 10_000,
    "MAX_SESSION_EXCHANGES_PER_ACCOUNT",
    "MAX_SESSION_EXCHANGES",
  );
  if ((maxLoginThrottles ?? DEFAULT_LOGIN_THROTTLE_LIMITS.global) < 2) {
    throw new TypeError("MAX_LOGIN_THROTTLES must be at least 2");
  }
  const effectiveMaxAuditEvents = maxAuditEvents ?? DEFAULT_AUDIT_EVENT_LIMITS.global;
  const effectiveAuditOperationalReserve = auditOperationalReserve ??
    DEFAULT_AUDIT_EVENT_LIMITS.operationalReserve;
  if (effectiveMaxAuditEvents < 2) {
    throw new TypeError("MAX_AUDIT_EVENTS must be at least 2");
  }
  if (effectiveAuditOperationalReserve >= effectiveMaxAuditEvents) {
    throw new TypeError(
      "AUDIT_OPERATIONAL_RESERVE must be less than MAX_AUDIT_EVENTS",
    );
  }
  assertSubLimit(
    maxOutstandingCarrierCredentialsPerAccount ?? 8,
    maxOutstandingCarrierCredentials ?? 128,
    "MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT",
    "MAX_OUTSTANDING_CARRIER_CREDENTIALS",
  );
  assertSubLimit(
    maxConcurrentWebAuthorizationsPerRemote ?? 4,
    maxConcurrentWebAuthorizations ?? 32,
    "MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE",
    "MAX_CONCURRENT_WEB_AUTHORIZATIONS",
  );
  if (maxPendingCarrierBytes !== undefined && maxPendingCarrierBytes < 65_551) {
    throw new TypeError("MAX_PENDING_CARRIER_BYTES must be at least 65551");
  }

  if (!isLoopbackBindHost(host) && databaseUrl === undefined && !insecureExternalPoc) {
    throw new Error(
      "인증 없는 Phase 1 POC는 loopback에만 바인딩됩니다. 외부 바인딩은 보안 MVP에서 구성하세요.",
    );
  }

  if (databaseUrl !== undefined && (controlHost === undefined || authSessionHmacKeyText === undefined)) {
    throw new Error("DATABASE_URL auth mode requires CONTROL_HOST and AUTH_SESSION_HMAC_KEY");
  }
  if (databaseUrl !== undefined && publicContentOriginText === undefined) {
    throw new Error("PUBLIC_CONTENT_ORIGIN is required in authenticated mode");
  }
  if (
    databaseUrl !== undefined &&
    (deploymentId === undefined || deploymentConfigDigest === undefined)
  ) {
    throw new Error(
      "authenticated mode requires DEPLOYMENT_ID and DEPLOYMENT_CONFIG_DIGEST",
    );
  }
  if (
    databaseUrl !== undefined &&
    (canaryHostText === undefined || canaryBearerToken === undefined)
  ) {
    throw new Error(
      "authenticated mode requires CANARY_HOST and CANARY_BEARER_TOKEN",
    );
  }
  if (
    databaseUrl !== undefined &&
    (environment.GATEWAY_ADMISSION_READY !== undefined ||
      environment.KILL_SWITCH_ENABLED !== undefined)
  ) {
    throw new Error(
      "authenticated mode reads admission and kill switch from PostgreSQL operational state",
    );
  }
  if (databaseUrl === undefined && (controlHost !== undefined || authSessionHmacKeyText !== undefined)) {
    throw new Error("DATABASE_URL, CONTROL_HOST and AUTH_SESSION_HMAC_KEY must be configured together");
  }
  if (
    databaseUrl === undefined &&
    (deploymentId !== undefined || deploymentConfigDigest !== undefined)
  ) {
    throw new Error("DEPLOYMENT_ID and DEPLOYMENT_CONFIG_DIGEST require DATABASE_URL");
  }
  if (
    databaseUrl === undefined &&
    (canaryHostText !== undefined || canaryBearerToken !== undefined)
  ) {
    throw new Error("CANARY_HOST and CANARY_BEARER_TOKEN require DATABASE_URL");
  }
  if (previousHmacKeyText !== undefined && authSessionHmacKeyText === undefined) {
    throw new Error("AUTH_SESSION_HMAC_KEY_PREVIOUS requires AUTH_SESSION_HMAC_KEY");
  }
  let authSessionHmacKey: Uint8Array | undefined;
  if (authSessionHmacKeyText !== undefined) {
    authSessionHmacKey = decodeHmacKey(authSessionHmacKeyText, "AUTH_SESSION_HMAC_KEY");
  }
  const previousHmacKeyValues = previousHmacKeyText === undefined
    ? []
    : previousHmacKeyText.split(",");
  if (previousHmacKeyValues.length > MAX_PREVIOUS_SESSION_HMAC_KEYS) {
    throw new Error("AUTH_SESSION_HMAC_KEY_PREVIOUS supports at most 3 previous HMAC keys");
  }
  const authSessionHmacPreviousKeys = previousHmacKeyValues.map((value, index) =>
    decodeHmacKey(value.trim(), `AUTH_SESSION_HMAC_KEY_PREVIOUS[${index}]`)
  );
  if (authSessionHmacKey !== undefined) {
    const encodedKeys = [authSessionHmacKey, ...authSessionHmacPreviousKeys]
      .map((key) => Buffer.from(key).toString("base64url"));
    if (new Set(encodedKeys).size !== encodedKeys.length) {
      throw new Error("active and previous HMAC keys must be unique");
    }
  }
  const publicContentOrigin = publicContentOriginText === undefined
    ? undefined
    : parsePublicContentOrigin(publicContentOriginText, contentDomain).origin;
  if (
    databaseUrl !== undefined &&
    publicContentOrigin !== undefined &&
    new URL(publicContentOrigin).protocol !== "https:" &&
    !insecureHttpAuth
  ) {
    throw new Error("authenticated mode requires an HTTPS PUBLIC_CONTENT_ORIGIN");
  }
  const deploymentIdentity = deploymentId === undefined || deploymentConfigDigest === undefined
    ? undefined
    : parseDeploymentIdentity(deploymentId, deploymentConfigDigest);
  if (controlHost !== undefined) {
    const normalizedControlHost = parseDomain(controlHost);
    if (
      normalizedControlHost === contentDomain ||
      normalizedControlHost.endsWith(`.${contentDomain}`)
    ) {
      throw new Error("CONTROL_HOST must not use the content wildcard namespace");
    }
  }
  if (insecureHttpAuth && !isLoopbackBindHost(host)) {
    throw new Error("ALLOW_INSECURE_HTTP_AUTH is only allowed on a loopback bind");
  }
  if (metricsBearerToken !== undefined && metricsBearerToken.length < 32) {
    throw new Error("METRICS_BEARER_TOKEN must contain at least 32 characters");
  }
  if (metricsBearerToken !== undefined && metricsBearerToken.length > 512) {
    throw new Error("METRICS_BEARER_TOKEN must contain at most 512 characters");
  }
  const canaryHost = canaryHostText === undefined ? undefined : parseDomain(canaryHostText);
  if (
    canaryHost !== undefined &&
    (canaryHost === contentDomain || !canaryHost.endsWith(`.${contentDomain}`))
  ) {
    throw new Error("CANARY_HOST must be a strict subdomain of CONTENT_DOMAIN");
  }
  if (canaryHost !== undefined && canaryHost === controlHost) {
    throw new Error("CANARY_HOST must differ from CONTROL_HOST");
  }
  if (canaryBearerToken !== undefined && canaryBearerToken.length < 32) {
    throw new Error("CANARY_BEARER_TOKEN must contain at least 32 characters");
  }
  if (canaryBearerToken !== undefined && canaryBearerToken.length > 512) {
    throw new Error("CANARY_BEARER_TOKEN must contain at most 512 characters");
  }

  return {
    host,
    port,
    contentDomain,
    ...(publicContentOrigin === undefined ? {} : { publicContentOrigin }),
    secureCookies: databaseUrl !== undefined && !insecureHttpAuth,
    autoMigrate: strictBoolean(environment.AUTO_MIGRATE, "AUTO_MIGRATE", false),
    initialKillSwitch: databaseUrl === undefined && strictBoolean(
      environment.KILL_SWITCH_ENABLED,
      "KILL_SWITCH_ENABLED",
      false,
    ),
    gatewayAdmissionReady,
    ...(metricsBearerToken === undefined ? {} : { metricsBearerToken }),
    ...(canaryHost === undefined ? {} : { canaryHost }),
    ...(canaryBearerToken === undefined ? {} : { canaryBearerToken }),
    ...(Object.keys(sessionLimits).length === 0 ? {} : { sessionLimits }),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    ...(carrierLeaseMs === undefined ? {} : { carrierLeaseMs }),
    ...(authorizationMaxAgeMs === undefined ? {} : { authorizationMaxAgeMs }),
    ...(authorizationCheckIntervalMs === undefined
      ? {}
      : { authorizationCheckIntervalMs }),
    ...(operationalStatePollIntervalMs === undefined
      ? {}
      : { operationalStatePollIntervalMs }),
    ...(databaseConnectionTimeoutMs === undefined
      ? {}
      : { databaseConnectionTimeoutMs }),
    ...(databaseQueryTimeoutMs === undefined ? {} : { databaseQueryTimeoutMs }),
    ...(maxPendingTunnels === undefined ? {} : { maxPendingTunnels }),
    ...(maxActiveTunnels === undefined ? {} : { maxActiveTunnels }),
    ...(maxTunnelsPerAccount === undefined ? {} : { maxTunnelsPerAccount }),
    ...(loginIntentsPerSourcePerMinute === undefined
      ? {}
      : { loginIntentsPerSourcePerMinute }),
    ...(loginIntentsGlobalPerMinute === undefined
      ? {}
      : { loginIntentsGlobalPerMinute }),
    ...(maxConcurrentLoginAttempts === undefined
      ? {}
      : { maxConcurrentLoginAttempts }),
    ...(maxConcurrentLoginAttemptsPerRemote === undefined
      ? {}
      : { maxConcurrentLoginAttemptsPerRemote }),
    ...(loginAttemptsPerMinute === undefined ? {} : { loginAttemptsPerMinute }),
    ...(loginAttemptsPerRemotePerMinute === undefined
      ? {}
      : { loginAttemptsPerRemotePerMinute }),
    ...(maxConcurrentWebAuthorizations === undefined
      ? {}
      : { maxConcurrentWebAuthorizations }),
    ...(maxConcurrentWebAuthorizationsPerRemote === undefined
      ? {}
      : { maxConcurrentWebAuthorizationsPerRemote }),
    ...(trustedProxyCidrs === undefined ? {} : { trustedProxyCidrs }),
    ...(maxForwardedForEntries === undefined ? {} : { maxForwardedForEntries }),
    ...(maxOutstandingCarrierCredentials === undefined
      ? {}
      : { maxOutstandingCarrierCredentials }),
    ...(maxOutstandingCarrierCredentialsPerAccount === undefined
      ? {}
      : { maxOutstandingCarrierCredentialsPerAccount }),
    ...(carrierCredentialsPerMinute === undefined
      ? {}
      : { carrierCredentialsPerMinute }),
    ...(carrierCredentialsPerAccountPerMinute === undefined
      ? {}
      : { carrierCredentialsPerAccountPerMinute }),
    ...(maxAuthSessions === undefined ? {} : { maxAuthSessions }),
    ...(maxAuthSessionsPerAccount === undefined ? {} : { maxAuthSessionsPerAccount }),
    ...(maxSessionExchanges === undefined ? {} : { maxSessionExchanges }),
    ...(maxSessionExchangesPerAccount === undefined
      ? {}
      : { maxSessionExchangesPerAccount }),
    ...(maxLoginThrottles === undefined ? {} : { maxLoginThrottles }),
    ...(maxAuditEvents === undefined ? {} : { maxAuditEvents }),
    ...(auditOperationalReserve === undefined
      ? {}
      : { auditOperationalReserve }),
    ...(maxPendingCarrierFrames === undefined ? {} : { maxPendingCarrierFrames }),
    ...(maxPendingCarrierBytes === undefined ? {} : { maxPendingCarrierBytes }),
    ...(maxCanaryWebSockets === undefined ? {} : { maxCanaryWebSockets }),
    ...(canaryWebSocketIdleTimeoutMs === undefined
      ? {}
      : { canaryWebSocketIdleTimeoutMs }),
    ...(deploymentIdentity === undefined ? {} : { deploymentIdentity }),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(controlHost === undefined ? {} : { controlHost: parseDomain(controlHost) }),
    ...(authSessionHmacKey === undefined ? {} : { authSessionHmacKey }),
    ...(authSessionHmacPreviousKeys.length === 0
      ? {}
      : { authSessionHmacPreviousKeys }),
  };
}

function assertSubLimit(
  perScope: number,
  global: number,
  perScopeName: string,
  globalName: string,
): void {
  if (perScope > global) {
    throw new TypeError(`${perScopeName} must be less than or equal to ${globalName}`);
  }
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

function optionalBoundedPositiveInteger(
  value: string | undefined,
  name: string,
  maximum: number,
): number | undefined {
  const parsed = optionalPositiveInteger(value, name);
  if (parsed !== undefined && parsed > maximum) {
    throw new TypeError(`${name} must be at most ${maximum}`);
  }
  return parsed;
}

function optionalTrustedProxyCidrs(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const cidrs = value.split(",").map((entry) => entry.trim());
  if (cidrs.length === 0 || cidrs.some((entry) => entry === "")) {
    throw new TypeError("TRUSTED_PROXY_CIDRS must contain comma-separated non-empty CIDRs");
  }
  if (new Set(cidrs).size !== cidrs.length) {
    throw new TypeError("TRUSTED_PROXY_CIDRS must not contain duplicate CIDRs");
  }
  createClientAddressResolver({ trustedProxyCidrs: cidrs });
  return cidrs;
}

function strictBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be either true or false`);
}

function decodeHmacKey(value: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must be base64url without padding`);
  }
  if (value.length > Math.ceil(MAX_SESSION_HMAC_KEY_BYTES * 8 / 6)) {
    throw new Error(`${name} must decode to at most ${MAX_SESSION_HMAC_KEY_BYTES} bytes`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(`${name} must use canonical base64url encoding`);
  }
  if (decoded.byteLength < 32) {
    throw new Error(`${name} must decode to at least 32 bytes`);
  }
  return decoded;
}

function compactSessionLimits(
  environment: Readonly<Record<string, string | undefined>>,
): Partial<SessionLimits> {
  const mappings = [
    ["maxRequestBodyBytes", "MAX_REQUEST_BODY_BYTES", 1024 * 1024 * 1024],
    ["maxFiniteResponseBytes", "MAX_FINITE_RESPONSE_BYTES", 1024 * 1024 * 1024],
    ["maxConcurrentStreams", "MAX_CONCURRENT_STREAMS", 10_000],
    ["maxNewStreamsPerMinute", "MAX_NEW_STREAMS_PER_MINUTE", 100_000],
    ["responseHeaderTimeoutMs", "RESPONSE_HEADER_TIMEOUT_MS", 10 * 60_000],
    ["streamInactivityTimeoutMs", "STREAM_INACTIVITY_TIMEOUT_MS", 24 * 60 * 60_000],
    ["maxStreamDurationMs", "MAX_STREAM_DURATION_MS", MAX_NODE_TIMER_MS],
  ] as const;
  const limits: Partial<Record<keyof SessionLimits, number>> = {};
  for (const [property, environmentName, maximum] of mappings) {
    const parsed = optionalBoundedPositiveInteger(
      environment[environmentName],
      environmentName,
      maximum,
    );
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
