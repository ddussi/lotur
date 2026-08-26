import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  AuthError,
  type AccountAuthorizationCheck,
  type AccountAuthorization,
  type AuthService,
  type DeveloperAuthorization,
  type Principal,
} from "../../../packages/auth/src/index.ts";

import {
  decodeEnvelope,
  decodeConfigAppliedMetadata,
  decodeHelloMetadata,
  decodeWindowUpdate,
  decodeResetStreamMetadata,
  decodeResponseHeadersMetadata,
  encodeMetadata,
  encodeWindowUpdate,
  CARRIER_PROFILE,
  createSessionConfigSnapshot,
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  digestSessionConfig,
  DEFAULT_SESSION_POLICY,
  DEFAULT_SESSION_LIMITS,
  FrameType,
  MAX_ENVELOPE_PAYLOAD_BYTES,
  INITIAL_SESSION_STATE,
  isResumeAllowed,
  SessionTransitionError,
  transitionSession,
  type ConnectionErrorCode,
  type ConfigAppliedMetadata,
  type SessionConfigMetadata,
  type SessionPolicy,
  type SessionLimits,
  type SessionState,
} from "../../../packages/protocol/src/index.ts";
import {
  headerPairsToOutgoingHeaders,
  isolateGatewayCredentials,
  rawHeadersToPairs,
  sanitizeHopByHopHeaders,
  stripUntrustedForwardingHeaders,
} from "../../../packages/proxy/src/index.ts";
import {
  INITIAL_CONNECTION_WINDOW_BYTES,
  INITIAL_STREAM_WINDOW_BYTES,
  OutboundFlowWindow,
  sendCarrierFrame,
  sendFlowControlledData,
} from "../../../packages/relay/src/index.ts";
import { createWebAuthHandler, WebAuthBoundaryError } from "./web-auth.ts";
import { GatewayStreamIds } from "./gateway-stream-ids.ts";
import { GatewayInboundFlow } from "./inbound-flow.ts";
import { GatewayMetrics } from "./metrics.ts";
import {
  buildTunnelShareUrl,
  parsePublicContentOrigin,
  type PublicContentOrigin,
} from "./public-content-origin.ts";
import {
  attachCanaryWebSocketEcho,
  CANARY_ECHO_MAX_PENDING_BYTES,
} from "./canary-echo.ts";
import { resumeOwnerAuthorizationMatches } from "./resume-authorization.ts";
import { retainAdmissionUntilSettled } from "./retained-operation.ts";

const CARRIER_PATH = "/_review-tunnel/carrier";
const CARRIER_ENVELOPE_HEADER_BYTES = 16;
const CARRIER_MAX_MESSAGE_BYTES = CARRIER_ENVELOPE_HEADER_BYTES + MAX_ENVELOPE_PAYLOAD_BYTES;
const CONFIG_ACK_RETRY_MS = DEFAULT_ACTIVATION_TIMEOUT_MS / 2;
const DEFAULT_MAX_PENDING_TUNNELS = 64;
const DEFAULT_MAX_ACTIVE_TUNNELS = 1_024;
const DEFAULT_MAX_TUNNELS_PER_ACCOUNT = 8;
const DEFAULT_LOGIN_INTENTS_PER_SOURCE_PER_MINUTE = 20;
const DEFAULT_LOGIN_INTENTS_GLOBAL_PER_MINUTE = 1_000;
const CREATE_RESERVATION_TTL_MS = 60_000;
const MAX_PENDING_DOWNSTREAM_FRAMES = 1_024;
const DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS = 128;
const DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT = 8;
const DEFAULT_CARRIER_CREDENTIALS_PER_MINUTE = 1_000;
const DEFAULT_CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE = 60;
const DEFAULT_MAX_CANARY_WEBSOCKETS = 4;
const DEFAULT_CANARY_WEBSOCKET_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_CARRIER_FRAMES = 128;
const DEFAULT_MAX_PENDING_CARRIER_BYTES = 4 * CARRIER_MAX_MESSAGE_BYTES;
const AUTHORIZATION_REVALIDATION_CONCURRENCY = 4;
const CONNECTION_ABORTED = Symbol("connection-aborted");
class PromiseDeadlineError extends Error {}
const RESERVED_GATEWAY_COOKIES = new Set([
  "__Host-rt_control",
  "__Host-rt_session",
  "rt_control_dev",
  "rt_session_dev",
]);

type GatewayTransportEpoch = Readonly<{
  socket: WebSocket;
  generation: number;
  outboundFlow: OutboundFlowWindow;
  inboundFlow: GatewayInboundFlow;
}>;

type GatewayHttpStream = {
  readonly kind: "HTTP";
  readonly transport: GatewayTransportEpoch;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  requestEnded: boolean;
  responseEnded: boolean;
  responseBytes: number;
  finiteResponse: boolean;
  responseBodyAllowed: boolean;
  downstreamQueuedFrames: number;
  downstreamQueue: Promise<void>;
  requestInactivityTimer?: NodeJS.Timeout;
  durationTimer?: NodeJS.Timeout;
  cancelled: boolean;
  readonly reviewerAccountId?: string;
  readonly reviewerAuthVersion?: number;
  readonly reviewerAuthorizedAt?: number;
};

type GatewayWebSocketStream = {
  readonly kind: "WEBSOCKET";
  readonly transport: GatewayTransportEpoch;
  readonly browserSocket: Duplex;
  readonly pendingHead: Uint8Array;
  responseStarted: boolean;
  upgraded: boolean;
  browserEnded: boolean;
  localEnded: boolean;
  downstreamQueuedFrames: number;
  downstreamQueue: Promise<void>;
  cancelled: boolean;
  readonly reviewerAccountId?: string;
  readonly reviewerAuthVersion?: number;
  readonly reviewerAuthorizedAt?: number;
  durationTimer?: NodeJS.Timeout;
};

type GatewayStream = GatewayHttpStream | GatewayWebSocketStream;

function settleWhileConnected<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof CONNECTION_ABORTED> {
  if (signal.aborted) return Promise.resolve(CONNECTION_ABORTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => resolve(CONNECTION_ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(signal.aborted ? CONNECTION_ABORTED : value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

type GatewaySession = {
  readonly sessionId: string;
  readonly tunnelId: string;
  readonly shareUrl: string;
  socket: WebSocket;
  readonly streams: Map<number, GatewayStream>;
  readonly streamIds: GatewayStreamIds;
  outboundFlow: OutboundFlowWindow;
  inboundFlow: GatewayInboundFlow;
  generation: number;
  revision: number;
  config: SessionConfigMetadata;
  lifecycle: SessionState;
  lastPongAt: number;
  developerAuthorizedAt: number;
  readonly now: () => number;
  readonly metrics: GatewayMetrics;
  readonly policy: SessionPolicy;
  streamRateWindowStartedAt: number;
  streamsOpenedInWindow: number;
  provisionId?: string;
  resumeSecret?: string;
  configAckTimer?: NodeJS.Timeout;
  configSendCount: number;
  appliedConfig?: ConfigAppliedMetadata;
  probe?: {
    readonly streamId: number;
    readonly expected: Buffer;
    readonly received: Buffer[];
    receivedBytes: number;
    clientEnded: boolean;
  };
  readonly resumeDigest: Buffer;
  expiryTimer?: NodeJS.Timeout;
  terminal: boolean;
  readonly ownerAccountId?: string;
  readonly ownerAuthVersion?: number;
  readonly disposeExpired: (session: GatewaySession, reason: string) => void;
};

function captureGatewayTransport(session: GatewaySession): GatewayTransportEpoch {
  return {
    socket: session.socket,
    generation: session.generation,
    outboundFlow: session.outboundFlow,
    inboundFlow: session.inboundFlow,
  };
}

function isCurrentGatewayTransport(
  session: GatewaySession,
  transport: GatewayTransportEpoch,
): boolean {
  return session.socket === transport.socket &&
    session.generation === transport.generation &&
    session.outboundFlow === transport.outboundFlow &&
    session.inboundFlow === transport.inboundFlow;
}

function isCurrentGatewaySessionTransport(
  sessions: ReadonlyMap<string, GatewaySession>,
  session: GatewaySession,
  transport: GatewayTransportEpoch,
): boolean {
  return sessions.get(session.tunnelId) === session &&
    isCurrentGatewayTransport(session, transport);
}

function isCurrentGatewayStream(
  session: GatewaySession,
  streamId: number,
  stream: GatewayStream,
): boolean {
  return isCurrentGatewayTransport(session, stream.transport) &&
    session.streams.get(streamId) === stream;
}

function isCurrentGatewaySessionStream(
  sessions: ReadonlyMap<string, GatewaySession>,
  session: GatewaySession,
  streamId: number,
  stream: GatewayStream,
): boolean {
  return sessions.get(session.tunnelId) === session &&
    isCurrentGatewayStream(session, streamId, stream);
}

export type GatewayServer = Readonly<{
  listen(): Promise<number>;
  close(): Promise<void>;
  setKillSwitch(enabled: boolean): void;
  isKillSwitchEnabled(): boolean;
  metrics(): string;
}>;

export type GatewayLogEvent = Readonly<{
  timestamp: string;
  event: string;
  tunnelRef?: string;
  generation?: number;
  streamId?: number;
  reason?: string;
}>;

export type GatewayServerOptions = Readonly<{
  host?: string;
  port?: number;
  contentDomain?: string;
  publicContentOrigin?: string;
  controlHost?: string;
  authService?: AuthService;
  secureCookies?: boolean;
  authorizationCheckIntervalMs?: number;
  activationTimeoutMs?: number;
  gatewayAdmissionReady?: () => boolean;
  sessionPolicy?: SessionPolicy;
  sessionTickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  carrierLeaseMs?: number;
  authorizationMaxAgeMs?: number;
  now?: () => number;
  sessionLimits?: Partial<SessionLimits>;
  initialKillSwitch?: boolean;
  persistKillSwitch?: (enabled: boolean, actor: AccountAuthorization) => Promise<void>;
  logger?: (event: GatewayLogEvent) => void;
  metricsBearerToken?: string;
  canaryHost?: string;
  canaryBearerToken?: string;
  maxCanaryWebSockets?: number;
  canaryWebSocketIdleTimeoutMs?: number;
  maxPendingCarrierFrames?: number;
  maxPendingCarrierBytes?: number;
  authorizationQueryTimeoutMs?: number;
  authCleanupTimeoutMs?: number;
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
}>;

export function createGatewayServer(
  options: GatewayServerOptions = {},
): GatewayServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const contentDomain = options.contentDomain ?? "localhost";
  const configuredPublicContentOrigin = options.publicContentOrigin === undefined
    ? undefined
    : parsePublicContentOrigin(options.publicContentOrigin, contentDomain);
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const gatewayAdmissionReady = options.gatewayAdmissionReady ?? (() => true);
  const sessionPolicy = options.sessionPolicy ?? DEFAULT_SESSION_POLICY;
  const sessionTickIntervalMs = options.sessionTickIntervalMs ?? 1_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const carrierLeaseMs = options.carrierLeaseMs ?? 45_000;
  const authorizationMaxAgeMs = options.authorizationMaxAgeMs ?? 12 * 60 * 60_000;
  const now = options.now ?? Date.now;
  const maxPendingTunnels = options.maxPendingTunnels ?? DEFAULT_MAX_PENDING_TUNNELS;
  const maxActiveTunnels = options.maxActiveTunnels ?? DEFAULT_MAX_ACTIVE_TUNNELS;
  const maxTunnelsPerAccount = options.maxTunnelsPerAccount ?? DEFAULT_MAX_TUNNELS_PER_ACCOUNT;
  const authorizationQueryTimeoutMs = options.authorizationQueryTimeoutMs ?? 3_000;
  const authCleanupTimeoutMs = options.authCleanupTimeoutMs ?? 10_000;
  const maxCanaryWebSockets = options.maxCanaryWebSockets ?? DEFAULT_MAX_CANARY_WEBSOCKETS;
  const canaryWebSocketIdleTimeoutMs = options.canaryWebSocketIdleTimeoutMs ??
    DEFAULT_CANARY_WEBSOCKET_IDLE_TIMEOUT_MS;
  const maxPendingCarrierFrames = options.maxPendingCarrierFrames ??
    DEFAULT_MAX_PENDING_CARRIER_FRAMES;
  const maxPendingCarrierBytes = options.maxPendingCarrierBytes ??
    DEFAULT_MAX_PENDING_CARRIER_BYTES;
  if (!Number.isSafeInteger(maxCanaryWebSockets) || maxCanaryWebSockets <= 0) {
    throw new RangeError("maxCanaryWebSockets must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(authorizationQueryTimeoutMs) ||
    authorizationQueryTimeoutMs <= 0
  ) {
    throw new RangeError("authorizationQueryTimeoutMs must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(canaryWebSocketIdleTimeoutMs) ||
    canaryWebSocketIdleTimeoutMs <= 0
  ) {
    throw new RangeError("canaryWebSocketIdleTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPendingCarrierFrames) || maxPendingCarrierFrames <= 0) {
    throw new RangeError("maxPendingCarrierFrames must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(maxPendingCarrierBytes) ||
    maxPendingCarrierBytes < CARRIER_MAX_MESSAGE_BYTES
  ) {
    throw new RangeError(
      `maxPendingCarrierBytes must be at least ${CARRIER_MAX_MESSAGE_BYTES}`,
    );
  }
  const sessions = new Map<string, GatewaySession>();
  const credentialReservations = new Map<string, Readonly<{
    accountId: string;
    purpose: "create" | "resume";
    tunnelId: string;
    expiresAt: number;
  }>>();
  const maxOutstandingCarrierCredentials = options.maxOutstandingCarrierCredentials ??
    DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS;
  const maxOutstandingCarrierCredentialsPerAccount =
    options.maxOutstandingCarrierCredentialsPerAccount ??
      DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT;
  const carrierCredentialRate = createFixedWindowRateLimiter({
    now,
    globalLimit: options.carrierCredentialsPerMinute ??
      DEFAULT_CARRIER_CREDENTIALS_PER_MINUTE,
    perKeyLimit: options.carrierCredentialsPerAccountPerMinute ??
      DEFAULT_CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE,
  });
  let pendingCarrierConnections = 0;
  let carrierAuthorizationAttempts = 0;
  const pendingCarrierReleases = new WeakMap<WebSocket, () => void>();
  const loginIntentLimiter = createFixedWindowRateLimiter({
    now,
    perKeyLimit: options.loginIntentsPerSourcePerMinute ??
      DEFAULT_LOGIN_INTENTS_PER_SOURCE_PER_MINUTE,
    globalLimit: options.loginIntentsGlobalPerMinute ??
      DEFAULT_LOGIN_INTENTS_GLOBAL_PER_MINUTE,
  });
  let killSwitchEnabled = options.initialKillSwitch ?? false;
  const sessionLimits: SessionLimits = {
    ...DEFAULT_SESSION_LIMITS,
    ...options.sessionLimits,
    maxStreamDurationMs: Math.min(
      options.sessionLimits?.maxStreamDurationMs ?? DEFAULT_SESSION_LIMITS.maxStreamDurationMs,
      sessionPolicy.maxTtlMs,
    ),
  };
  const webAuth = options.authService === undefined ? undefined : createWebAuthHandler({
    authService: options.authService,
    controlHost: options.controlHost ?? `control.${contentDomain}`,
    secureCookies: options.secureCookies ?? true,
    authorizationQueryTimeoutMs,
    async setKillSwitch(enabled, actor) {
      await options.persistKillSwitch?.(enabled, actor);
      updateKillSwitch(enabled);
    },
    getKillSwitch() {
      return killSwitchEnabled;
    },
    reserveCarrierCredential(principal, purpose, tunnelId) {
      cleanupCredentialReservations();
      if (!hasPendingTunnelCapacity()) return undefined;
      if (purpose === "create" && !canAdmitNewTunnel(principal.accountId, tunnelId)) {
        return undefined;
      }
      let accountOutstanding = 0;
      for (const reservation of credentialReservations.values()) {
        if (reservation.accountId === principal.accountId) accountOutstanding += 1;
      }
      if (
        credentialReservations.size >= maxOutstandingCarrierCredentials ||
        accountOutstanding >= maxOutstandingCarrierCredentialsPerAccount ||
        !carrierCredentialRate.admit(principal.accountId)
      ) {
        return undefined;
      }
      const reservationId = randomBytes(16).toString("base64url");
      credentialReservations.set(reservationId, {
        accountId: principal.accountId,
        purpose,
        tunnelId,
        expiresAt: now() + CREATE_RESERVATION_TTL_MS,
      });
      return () => credentialReservations.delete(reservationId);
    },
    admitLoginIntent(remoteAddress, _targetHost) {
      return loginIntentLimiter.admit(remoteAddress);
    },
    ...(options.maxConcurrentLoginAttempts === undefined
      ? {}
      : { maxConcurrentLoginAttempts: options.maxConcurrentLoginAttempts }),
    ...(options.maxConcurrentLoginAttemptsPerRemote === undefined
      ? {}
      : {
          maxConcurrentLoginAttemptsPerRemote:
            options.maxConcurrentLoginAttemptsPerRemote,
        }),
    ...(options.loginAttemptsPerMinute === undefined
      ? {}
      : { loginAttemptsPerMinute: options.loginAttemptsPerMinute }),
    ...(options.loginAttemptsPerRemotePerMinute === undefined
      ? {}
      : {
          loginAttemptsPerRemotePerMinute:
            options.loginAttemptsPerRemotePerMinute,
        }),
    ...(options.maxConcurrentWebAuthorizations === undefined
      ? {}
      : { maxConcurrentWebAuthorizations: options.maxConcurrentWebAuthorizations }),
    ...(options.maxConcurrentWebAuthorizationsPerRemote === undefined
      ? {}
      : {
          maxConcurrentWebAuthorizationsPerRemote:
            options.maxConcurrentWebAuthorizationsPerRemote,
        }),
    ...(options.trustedProxyCidrs === undefined
      ? {}
      : { trustedProxyCidrs: options.trustedProxyCidrs }),
    ...(options.maxForwardedForEntries === undefined
      ? {}
      : { maxForwardedForEntries: options.maxForwardedForEntries }),
  });
  const controlHostname = hostnameOf(options.controlHost ?? `control.${contentDomain}`);
  const resumeHmacKey = randomBytes(32);
  const metricsTokenDigest = options.metricsBearerToken === undefined
    ? undefined
    : digestOperationalToken(resumeHmacKey, options.metricsBearerToken);
  const canaryTokenDigest = options.canaryBearerToken === undefined
    ? undefined
    : digestOperationalToken(resumeHmacKey, options.canaryBearerToken);
  const canaryHostname = options.canaryHost === undefined
    ? undefined
    : hostnameOf(options.canaryHost);
  const metrics = new GatewayMetrics();
  const emit = (
    event: string,
    session?: GatewaySession,
    details: Readonly<{ streamId?: number; reason?: string }> = {},
  ) => {
    options.logger?.({
      timestamp: new Date(now()).toISOString(),
      event,
      ...(session === undefined
        ? {}
        : {
            tunnelRef: tunnelReference(resumeHmacKey, session.tunnelId),
            generation: session.generation,
          }),
      ...details,
    });
  };
  let healthCheckInFlight: Promise<void> | undefined;
  const sharedAuthHealthCheck = (): Promise<void> => {
    if (options.authService === undefined) return Promise.resolve();
    if (healthCheckInFlight !== undefined) return healthCheckInFlight;
    let running: Promise<void>;
    try {
      running = options.authService.checkHealth();
    } catch (error) {
      return Promise.reject(error);
    }
    healthCheckInFlight = running;
    const release = () => {
      if (healthCheckInFlight === running) healthCheckInFlight = undefined;
    };
    retainAdmissionUntilSettled(running, release);
    return running;
  };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        let reviewer: Principal | undefined;
        const requestPath = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
        if (
          canaryHostname !== undefined &&
          hostnameOf(request.headers.host) === canaryHostname
        ) {
          handleCanaryRequest(request, response, resumeHmacKey, canaryTokenDigest);
          return;
        }
        if (hostnameOf(request.headers.host) === controlHostname && requestPath === "/health/live") {
          writeHealth(response, 200);
          return;
        }
        if (hostnameOf(request.headers.host) === controlHostname && requestPath === "/health/ready") {
          try {
            if (options.authService !== undefined) {
              await withPromiseDeadline(
                sharedAuthHealthCheck(),
                authorizationQueryTimeoutMs,
                "authentication health query timed out",
              );
            }
            writeHealth(response, 200);
          } catch {
            writeHealth(response, 503);
          }
          return;
        }
        if (hostnameOf(request.headers.host) === controlHostname && requestPath === "/metrics") {
          const bearer = readBearerToken(request.headers.authorization);
          if (
            metricsTokenDigest === undefined ||
            bearer === undefined ||
            !operationalTokenMatches(resumeHmacKey, bearer, metricsTokenDigest)
          ) {
            writeGatewayError(response, metricsTokenDigest === undefined ? 404 : 401, "NOT_FOUND");
            return;
          }
          writeMetrics(response, metrics.render(metricSnapshot()));
          return;
        }
        if (webAuth !== undefined && hostnameOf(request.headers.host) === controlHostname) {
          await webAuth.handleControl(request, response);
          return;
        }
        if (killSwitchEnabled) {
          writeGatewayError(response, 503, "SERVICE_DISABLED");
          return;
        }
        const tunnelId = getTunnelId(request.headers.host, contentDomain);
        if (
          webAuth !== undefined &&
          tunnelId === undefined
        ) {
          writeGatewayError(response, 404, "NOT_FOUND");
          return;
        }
        if (webAuth !== undefined) {
          const connectionAbort = new AbortController();
          const markConnectionClosed = () => {
            connectionAbort.abort();
          };
          if (request.destroyed || response.destroyed || request.socket.destroyed) {
            markConnectionClosed();
          }
          request.once("aborted", markConnectionClosed);
          response.once("close", markConnectionClosed);
          request.socket.once("close", markConnectionClosed);
          try {
            const authorization = await settleWhileConnected(
              webAuth.authorizeContent(request, response),
              connectionAbort.signal,
            );
            if (authorization === CONNECTION_ABORTED) {
              emit("reviewer.authorization_cancelled", undefined, { reason: "http" });
              return;
            }
            reviewer = authorization;
          } finally {
            request.off("aborted", markConnectionClosed);
            response.off("close", markConnectionClosed);
            request.socket.off("close", markConnectionClosed);
          }
          if (reviewer === undefined || connectionAbort.signal.aborted) return;
        }
        if (requestPath.startsWith("/_review-tunnel/")) {
          writeGatewayError(response, 404, "NOT_FOUND");
          return;
        }
        await handleReviewerRequest(
          sessions,
          tunnelId,
          request,
          response,
          reviewer,
        );
      } catch {
        if (response.headersSent) {
          response.destroy();
          request.destroy();
        } else {
          writeGatewayError(response, 500, "INTERNAL_ERROR");
        }
      }
    })();
  });
  const serverSockets = new Set<Socket>();
  server.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
  });
  const carriers = new WebSocketServer({
    noServer: true,
    autoPong: false,
    perMessageDeflate: false,
    maxPayload: CARRIER_MAX_MESSAGE_BYTES,
    handleProtocols(protocols) {
      return protocols.has(CARRIER_PROFILE) ? CARRIER_PROFILE : false;
    },
  });
  const canaryWebSockets = new WebSocketServer({
    noServer: true,
    autoPong: false,
    perMessageDeflate: false,
    maxPayload: CANARY_ECHO_MAX_PENDING_BYTES,
  });
  canaryWebSockets.on("connection", (socket) => {
    attachCanaryWebSocketEcho(socket, canaryWebSocketIdleTimeoutMs);
  });
  const carrierAuthorizations = new WeakMap<WebSocket, DeveloperAuthorization>();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    if (
      canaryHostname !== undefined &&
      hostnameOf(request.headers.host) === canaryHostname
    ) {
      const bearer = readBearerToken(request.headers.authorization);
      if (
        canaryTokenDigest === undefined ||
        bearer === undefined ||
        !operationalTokenMatches(resumeHmacKey, bearer, canaryTokenDigest)
      ) {
        writeRawError(socket, 401, "AUTHENTICATION_REQUIRED");
        return;
      }
      if (url.pathname !== "/websocket") {
        writeRawError(socket, 404, "NOT_FOUND");
        return;
      }
      if (canaryWebSockets.clients.size >= maxCanaryWebSockets) {
        writeRawError(socket, 429, "CONNECTION_LIMIT_EXCEEDED");
        return;
      }
      canaryWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        canaryWebSockets.emit("connection", webSocket, request);
      });
      return;
    }
    if (killSwitchEnabled) {
      writeRawError(socket, 503, "SERVICE_DISABLED");
      return;
    }
    if (url.pathname !== CARRIER_PATH) {
      if (request.headers.upgrade?.toLowerCase() !== "websocket") {
        writeRawError(socket, 501, "UNSUPPORTED_UPGRADE");
        return;
      }
      const tunnelId = getTunnelId(request.headers.host, contentDomain);
      if (
        webAuth !== undefined &&
        tunnelId === undefined
      ) {
        writeRawError(socket, 404, "NOT_FOUND");
        return;
      }
      void (async () => {
        let reviewer: Principal | undefined;
        if (webAuth !== undefined) {
          const connectionAbort = new AbortController();
          const markConnectionClosed = () => {
            connectionAbort.abort();
          };
          if (socket.destroyed || socket.readableEnded || !socket.readable || !socket.writable) {
            markConnectionClosed();
          }
          socket.once("end", markConnectionClosed);
          socket.once("error", markConnectionClosed);
          socket.once("close", markConnectionClosed);
          try {
            const authorization = await settleWhileConnected(
              webAuth.resolveContentUpgrade(request),
              connectionAbort.signal,
            );
            if (authorization === CONNECTION_ABORTED) {
              emit("reviewer.authorization_cancelled", undefined, { reason: "upgrade" });
              return;
            }
            reviewer = authorization;
          } finally {
            socket.off("end", markConnectionClosed);
            socket.off("error", markConnectionClosed);
            socket.off("close", markConnectionClosed);
          }
          if (connectionAbort.signal.aborted) return;
          if (hostnameOf(request.headers.host) === controlHostname || reviewer === undefined) {
            writeRawError(socket, 401, "AUTHENTICATION_REQUIRED");
            return;
          }
        }
        await handleReviewerUpgrade(
          sessions,
          tunnelId,
          request,
          socket,
          head,
          reviewer,
        );
      })().catch((error: unknown) => {
        if (error instanceof WebAuthBoundaryError) {
          writeRawError(socket, error.statusCode, error.code);
          return;
        }
        writeRawError(socket, 503, "AUTHENTICATION_UNAVAILABLE");
      });
      return;
    }
    if (head.byteLength !== 0) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!offersOnlyCarrierProfile(request.headers["sec-websocket-protocol"])) {
      writeRawError(socket, 426, "CARRIER_SUBPROTOCOL_REQUIRED");
      return;
    }
    const releaseCarrierAuthorization = options.authService === undefined
      ? undefined
      : reserveCarrierAuthorizationAttempt();
    let releasePendingCarrier = options.authService === undefined
      ? reservePendingCarrierConnection()
      : undefined;
    if (
      (options.authService === undefined && releasePendingCarrier === undefined) ||
      (options.authService !== undefined && releaseCarrierAuthorization === undefined)
    ) {
      writeRawError(socket, 429, "TUNNEL_LIMIT_EXCEEDED");
      return;
    }
    if (releasePendingCarrier !== undefined) socket.once("close", releasePendingCarrier);
    void (async () => {
      let authorization: DeveloperAuthorization | undefined;
      if (options.authService !== undefined) {
        if (hostnameOf(request.headers.host) !== controlHostname) {
          writeRawError(socket, 404, "NOT_FOUND");
          return;
        }
        const token = readBearerToken(request.headers.authorization);
        if (token === undefined) {
          writeRawError(socket, 401, "AUTHENTICATION_REQUIRED");
          return;
        }
        try {
          authorization = await options.authService.consumeCarrierCredential(token);
          consumeCredentialReservation(authorization);
        } catch (error) {
          writeRawError(
            socket,
            error instanceof AuthError ? 401 : 503,
            error instanceof AuthError
              ? "AUTHENTICATION_FAILED"
              : "AUTHENTICATION_UNAVAILABLE",
          );
          return;
        }
        if (socket.destroyed || !socket.readable || !socket.writable) return;
        releasePendingCarrier = reservePendingCarrierConnection();
        if (releasePendingCarrier === undefined) {
          writeRawError(socket, 429, "TUNNEL_LIMIT_EXCEEDED");
          return;
        }
        socket.once("close", releasePendingCarrier);
        if (socket.destroyed || !socket.readable || !socket.writable) {
          releasePendingCarrier();
          return;
        }
      }
      const establishedPendingCarrier = releasePendingCarrier;
      if (establishedPendingCarrier === undefined) {
        throw new Error("pending Carrier reservation was not established");
      }
      carriers.handleUpgrade(request, socket, head, (webSocket) => {
        pendingCarrierReleases.set(webSocket, establishedPendingCarrier);
        if (authorization !== undefined) carrierAuthorizations.set(webSocket, authorization);
        carriers.emit("connection", webSocket, request);
      });
    })().catch(() => {
      releasePendingCarrier?.();
      writeRawError(socket, 500, "INTERNAL_ERROR");
    }).finally(() => releaseCarrierAuthorization?.());
  });
  server.on("connect", (_request, socket) => {
    writeRawError(socket, 501, "CONNECT_NOT_SUPPORTED");
  });

  carriers.on("connection", (socket) => {
    const releasePendingCarrier = pendingCarrierReleases.get(socket) ?? (() => undefined);
    const developerAuthorization = carrierAuthorizations.get(socket);
    let session: GatewaySession | undefined;
    let connectionMode: "create" | "resume" | undefined;
    let resumeAttemptId: string | undefined;
    let receiveQueue = Promise.resolve();
    let pendingCarrierFrames = 0;
    let pendingCarrierBytes = 0;
    let receiveFailed = false;
    const rejectWebSocketControlFrame = () => {
      if (receiveFailed) return;
      receiveFailed = true;
      emit("carrier.protocol_error", session, {
        reason: "WebSocket control ping/pong is unsupported",
      });
      socket.close(1002, "WebSocket control frames unsupported");
    };
    const helloTimer = setTimeout(() => {
      if (session === undefined) socket.close(1008, "HELLO timeout");
    }, 5_000);
    helloTimer.unref();
    socket.on("ping", rejectWebSocketControlFrame);
    socket.on("pong", rejectWebSocketControlFrame);

    socket.on("message", (data, isBinary) => {
      if (receiveFailed) return;
      const messageBytes = rawDataByteLength(data);
      if (
        pendingCarrierFrames >= maxPendingCarrierFrames ||
        pendingCarrierBytes + messageBytes > maxPendingCarrierBytes
      ) {
        receiveFailed = true;
        emit("carrier.protocol_error", session, { reason: "Carrier receive queue exceeded" });
        socket.close(1009, "Carrier receive queue exceeded");
        return;
      }
      pendingCarrierFrames += 1;
      pendingCarrierBytes += messageBytes;
      receiveQueue = receiveQueue
        .then(async () => {
          if (receiveFailed) return;
          if (!isBinary) throw new Error("Carrier accepts binary frames only");
          const envelope = decodeEnvelope(asBytes(data));
          if (session === undefined) {
            if (envelope.type !== FrameType.Hello || envelope.generation !== 0) {
              throw new Error("HELLO must be the first Carrier frame");
            }
            const hello = decodeHelloMetadata(envelope.payload);
            if (
              options.authService !== undefined &&
              (developerAuthorization === undefined ||
                developerAuthorization.purpose !== hello.mode ||
                developerAuthorization.tunnelId !== hello.tunnelId)
            ) {
              socket.close(1008, "carrier authorization mismatch");
              return;
            }
            releasePendingCarrier();
            if (hello.mode === "create") {
              if (sessions.has(hello.tunnelId)) {
                await rejectCarrier(socket, 0, "PROTOCOL_ERROR");
                return;
              }
              if (!canAdmitNewTunnel(developerAuthorization?.accountId, hello.tunnelId)) {
                await rejectCarrier(socket, 0, "RELAY_NOT_READY", 1_000);
                return;
              }
              const resumeSecret = randomBytes(32).toString("base64url");
              const provisionId = randomBytes(16).toString("base64url");
              const generation = 1;
              const shareUrl = shareUrlFor(
                server,
                hello.tunnelId,
                contentDomain,
                options.secureCookies ?? options.authService !== undefined,
                configuredPublicContentOrigin,
              );
              const snapshot = createSessionConfigSnapshot({
                generation,
                localOriginFingerprint: hello.localOriginFingerprint,
                originProjection: hello.originProjection,
                publicOrigin: new URL(shareUrl).origin,
                initialConnectionWindowBytes: INITIAL_CONNECTION_WINDOW_BYTES,
                initialStreamWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
                policy: sessionPolicy,
                limits: sessionLimits,
              });
              session = {
                sessionId: randomBytes(16).toString("base64url"),
                tunnelId: hello.tunnelId,
                shareUrl,
                socket,
                streams: new Map(),
                streamIds: new GatewayStreamIds(),
                outboundFlow: new OutboundFlowWindow(
                  INITIAL_CONNECTION_WINDOW_BYTES,
                ),
                inboundFlow: new GatewayInboundFlow(
                  INITIAL_CONNECTION_WINDOW_BYTES,
                  maxPendingCarrierFrames,
                ),
                generation,
                revision: 1,
                config: {
                  revision: 1,
                  digest: digestSessionConfig(snapshot),
                  snapshot,
                },
                lifecycle: INITIAL_SESSION_STATE,
                lastPongAt: now(),
                developerAuthorizedAt: now(),
                now,
                metrics,
                policy: sessionPolicy,
                streamRateWindowStartedAt: now(),
                streamsOpenedInWindow: 0,
                provisionId,
                resumeSecret,
                configSendCount: 0,
                resumeDigest: digestResumeSecret(resumeHmacKey, resumeSecret),
                terminal: false,
                disposeExpired: expireGatewaySession,
                ...(developerAuthorization === undefined ? {} : {
                  ownerAccountId: developerAuthorization.accountId,
                  ownerAuthVersion: developerAuthorization.accountAuthVersion,
                }),
              };
              sessions.set(hello.tunnelId, session);
              metrics.increment("tunnel_provisioned");
              emit("tunnel.provisioned", session);
            } else {
              const existing = sessions.get(hello.tunnelId);
              if (
                existing === undefined ||
                existing.lifecycle.status !== "RECONNECTING" ||
                !isResumeAllowed(now(), existing.lifecycle.disconnectedAt, sessionPolicy) ||
                !resumeSecretMatches(
                  resumeHmacKey,
                  hello.resumeSecret,
                  existing.resumeDigest,
                )
              ) {
                await rejectCarrier(socket, 0, "RESUME_REJECTED");
                return;
              }
              if (!resumeOwnerAuthorizationMatches(
                existing.ownerAccountId === undefined || existing.ownerAuthVersion === undefined
                  ? undefined
                  : {
                      accountId: existing.ownerAccountId,
                      accountAuthVersion: existing.ownerAuthVersion,
                    },
                developerAuthorization,
              )) {
                await rejectCarrier(socket, 0, "AUTH_FAILED");
                return;
              }
              if (
                existing.config.snapshot.localOriginFingerprint !==
                  hello.localOriginFingerprint ||
                existing.config.snapshot.originProjection !== hello.originProjection
              ) {
                await rejectCarrier(socket, 0, "CONFIG_APPLY_FAILED");
                return;
              }
              const attemptId = randomBytes(16).toString("base64url");
              try {
                const nextLifecycle = transitionSession(existing.lifecycle, {
                  type: "START_RESUME",
                  now: now(),
                  attemptId,
                }, sessionPolicy);
                if (!applySessionTransition(existing, nextLifecycle)) {
                  await rejectCarrier(socket, 0, "RESUME_REJECTED");
                  return;
                }
                if (nextLifecycle.status !== "RECONNECTING") {
                  throw new Error("resume start did not remain RECONNECTING");
                }
              } catch (error) {
                if (
                  error instanceof SessionTransitionError &&
                  error.code === "RESUME_IN_PROGRESS"
                ) {
                  await rejectCarrier(socket, 0, "RESUME_IN_PROGRESS", 500);
                  return;
                }
                throw error;
              }
              session = existing;
              resumeAttemptId = attemptId;
              disposeActivationCandidate(existing);
              existing.socket = socket;
              existing.outboundFlow = new OutboundFlowWindow(
                INITIAL_CONNECTION_WINDOW_BYTES,
              );
              existing.inboundFlow = new GatewayInboundFlow(
                INITIAL_CONNECTION_WINDOW_BYTES,
                maxPendingCarrierFrames,
              );
              existing.streamIds.reset();
              if (existing.lifecycle.candidateGeneration === undefined) {
                throw new Error("resume candidate has no generation");
              }
              existing.generation = existing.lifecycle.candidateGeneration;
              existing.revision += 1;
              const snapshot = createSessionConfigSnapshot({
                generation: existing.generation,
                localOriginFingerprint: hello.localOriginFingerprint,
                originProjection: hello.originProjection,
                publicOrigin: new URL(existing.shareUrl).origin,
                initialConnectionWindowBytes: INITIAL_CONNECTION_WINDOW_BYTES,
                initialStreamWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
                policy: sessionPolicy,
                limits: sessionLimits,
              });
              existing.config = {
                revision: existing.revision,
                digest: digestSessionConfig(snapshot),
                snapshot,
              };
              existing.lastPongAt = now();
              existing.developerAuthorizedAt = now();
              existing.configSendCount = 0;
              delete existing.appliedConfig;
            }
            connectionMode = hello.mode;
            if (hello.mode === "create") {
              await sendCarrierFrame(socket, {
                type: FrameType.SessionProvisioned,
                generation: session.generation,
                streamId: 0,
                payload: encodeMetadata({
                  sessionId: session.sessionId,
                  provisionId: session.provisionId,
                  tunnelId: session.tunnelId,
                  shareUrl: session.shareUrl,
                  resumeSecret: session.resumeSecret,
                }),
              });
              if (
                sessions.get(session.tunnelId) !== session ||
                session.socket !== socket
              ) return;
            }
            const configTransport = captureGatewayTransport(session);
            await sendSessionConfig(session, configTransport);
            if (!isCurrentGatewaySessionTransport(sessions, session, configTransport)) {
              return;
            }
            armActivationTimeout(
              session,
              configTransport,
              activationTimeoutMs,
            );
            clearTimeout(helloTimer);
            return;
          }
          if (envelope.generation !== session.generation) {
            throw new Error("stale Carrier generation");
          }
          if (envelope.type === FrameType.Pong && envelope.streamId === 0) {
            if (envelope.payload.byteLength !== 0) throw new Error("PONG payload must be empty");
            session.lastPongAt = now();
            return;
          }
          if (envelope.type === FrameType.Ping && envelope.streamId === 0) {
            if (envelope.payload.byteLength !== 0) throw new Error("PING payload must be empty");
            await sendCarrierFrame(socket, {
              type: FrameType.Pong,
              generation: session.generation,
              streamId: 0,
            });
            return;
          }
          if (session.lifecycle.status !== "ACTIVE") {
            if (envelope.type === FrameType.ConfigApplied) {
              const applied = decodeConfigAppliedMetadata(envelope.payload);
              if (session.appliedConfig !== undefined) {
                if (sameConfigApplied(session.appliedConfig, applied)) return;
                await rejectCarrier(socket, session.generation, "CONFIG_APPLY_FAILED");
                return;
              }
              if (
                applied.revision !== session.config.revision ||
                applied.digest !== session.config.digest
              ) {
                await rejectCarrier(socket, session.generation, "CONFIG_APPLY_FAILED");
                return;
              }
              if (
                connectionMode === "create" &&
                applied.provisionReceipt !== session.provisionId
              ) {
                await rejectCarrier(
                  socket,
                  session.generation,
                  "PROVISION_RECEIPT_FAILED",
                );
                return;
              }
              if (!applied.localOriginReady) {
                await rejectCarrier(
                  socket,
                  session.generation,
                  "LOCAL_ORIGIN_UNAVAILABLE",
                );
                return;
              }
              if (applied.result !== "APPLIED") {
                await rejectCarrier(socket, session.generation, "CONFIG_APPLY_FAILED");
                return;
              }
              session.appliedConfig = applied;
              delete session.provisionId;
              delete session.resumeSecret;
              if (session.probe === undefined) {
                metrics.increment("config_applied");
                emit("tunnel.config_applied", session);
                const streamId = session.streamIds.issue();
                const nonce = randomBytes(32);
                const probe = {
                  streamId,
                  expected: nonce,
                  received: [],
                  receivedBytes: 0,
                  clientEnded: false,
                };
                const probeTransport = captureGatewayTransport(session);
                session.probe = probe;
                probeTransport.outboundFlow.openStream(
                  streamId,
                  INITIAL_STREAM_WINDOW_BYTES,
                );
                probeTransport.inboundFlow.openStream(
                  streamId,
                  INITIAL_STREAM_WINDOW_BYTES,
                );
                await sendCarrierFrame(probeTransport.socket, {
                  type: FrameType.OpenProbe,
                  generation: probeTransport.generation,
                  streamId,
                  payload: encodeMetadata({
                    initialWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
                  }),
                });
                if (
                  !isCurrentGatewaySessionTransport(sessions, session, probeTransport) ||
                  session.probe !== probe
                ) return;
                await sendFlowControlledData(
                  probeTransport.socket,
                  probeTransport.outboundFlow,
                  {
                  generation: probeTransport.generation,
                  streamId,
                  chunk: nonce,
                  },
                );
                if (
                  !isCurrentGatewaySessionTransport(sessions, session, probeTransport) ||
                  session.probe !== probe
                ) return;
                await sendCarrierFrame(probeTransport.socket, {
                  type: FrameType.EndStream,
                  generation: probeTransport.generation,
                  streamId,
                });
              }
              return;
            }
            const probe = session.probe;
            if (probe === undefined || envelope.streamId !== probe.streamId) {
              throw new Error("application frame before SESSION_ACTIVE");
            }
            if (envelope.type === FrameType.WindowUpdate) {
              session.outboundFlow.update(
                envelope.streamId,
                decodeWindowUpdate(envelope.payload),
              );
              return;
            }
            if (envelope.type === FrameType.Data) {
              const probeTransport = captureGatewayTransport(session);
              probeTransport.inboundFlow.consume(
                probe.streamId,
                envelope.payload.byteLength,
              );
              probe.receivedBytes += envelope.payload.byteLength;
              if (probe.receivedBytes > probe.expected.byteLength) {
                throw new Error("Relay probe payload is too large");
              }
              probe.received.push(Buffer.from(envelope.payload));
              await sendWindowUpdate(
                probeTransport,
                probe.streamId,
                envelope.payload.byteLength,
              );
              if (
                !isCurrentGatewaySessionTransport(sessions, session, probeTransport) ||
                session.probe !== probe
              ) return;
              probeTransport.inboundFlow.release(
                probe.streamId,
                envelope.payload.byteLength,
              );
              return;
            }
            if (envelope.type === FrameType.EndStream) {
              if (probe.clientEnded) throw new Error("duplicate Relay probe END");
              probe.clientEnded = true;
              const received = Buffer.concat(probe.received);
              if (
                received.byteLength !== probe.expected.byteLength ||
                !timingSafeEqual(received, probe.expected)
              ) {
                await rejectCarrier(socket, session.generation, "RELAY_NOT_READY");
                return;
              }
              if (killSwitchEnabled || !gatewayAdmissionReady()) {
                await rejectCarrier(socket, session.generation, "RELAY_NOT_READY");
                return;
              }
              if (!canActivateTunnel(session)) {
                await rejectCarrier(socket, session.generation, "RELAY_NOT_READY", 1_000);
                return;
              }
              session.outboundFlow.closeStream(probe.streamId);
              session.inboundFlow.closeStream(probe.streamId);
              delete session.probe;
              const resumed = session.lifecycle.status === "RECONNECTING";
              if (session.lifecycle.status === "CREATING") {
                session.lifecycle = transitionSession(
                  session.lifecycle,
                  { type: "ACTIVATE", now: now() },
                  sessionPolicy,
                );
              } else {
                if (resumeAttemptId === undefined) {
                  throw new Error("resume candidate has no attempt ID");
                }
                const nextLifecycle = transitionSession(session.lifecycle, {
                  type: "RESUME_COMMITTED",
                  now: now(),
                  attemptId: resumeAttemptId,
                }, sessionPolicy);
                if (!applySessionTransition(session, nextLifecycle)) return;
              }
              if (
                session.lifecycle.status !== "ACTIVE" ||
                session.lifecycle.generation !== session.generation
              ) {
                throw new Error("activation commit generation mismatch");
              }
              const activationTransport = captureGatewayTransport(session);
              await sendCarrierFrame(activationTransport.socket, {
                type: FrameType.SessionActive,
                generation: activationTransport.generation,
                streamId: 0,
                payload: encodeMetadata({
                  generation: activationTransport.generation,
                  tunnelId: session.tunnelId,
                  shareUrl: session.shareUrl,
                  readiness: {
                    carrier: true,
                    config: true,
                    origin: true,
                    relay: true,
                    route: true,
                    admission: true,
                  },
                }),
              });
              if (
                !isCurrentGatewaySessionTransport(
                  sessions,
                  session,
                  activationTransport,
                ) ||
                session.lifecycle.status !== "ACTIVE" ||
                session.lifecycle.generation !== activationTransport.generation
              ) return;
              if (session.configAckTimer !== undefined) {
                clearTimeout(session.configAckTimer);
                delete session.configAckTimer;
              }
              if (session.expiryTimer !== undefined) {
                clearTimeout(session.expiryTimer);
                delete session.expiryTimer;
              }
              metrics.increment(resumed ? "tunnel_resumed" : "tunnel_active");
              emit(resumed ? "tunnel.resumed" : "tunnel.active", session);
              return;
            }
            throw new Error("unexpected activation frame");
          }
          if (envelope.type === FrameType.CloseSession && envelope.streamId === 0) {
            receiveFailed = true;
            session.terminal = true;
            socket.close(1000, "session closed");
            return;
          }
          if (envelope.type === FrameType.ConfigApplied && envelope.streamId === 0) {
            const applied = decodeConfigAppliedMetadata(envelope.payload);
            if (
              session.appliedConfig !== undefined &&
              sameConfigApplied(session.appliedConfig, applied)
            ) {
              return;
            }
            await rejectCarrier(socket, session.generation, "CONFIG_APPLY_FAILED");
            return;
          }
          await handleClientFrame(session, envelope);
        })
        .catch((error: unknown) => {
          receiveFailed = true;
          emit("carrier.protocol_error", session, { reason: toSafeErrorReason(error) });
          socket.close(1002, "protocol error");
        })
        .finally(() => {
          pendingCarrierFrames -= 1;
          pendingCarrierBytes -= messageBytes;
        });
    });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(helloTimer);
      socket.off("ping", rejectWebSocketControlFrame);
      socket.off("pong", rejectWebSocketControlFrame);
      if (
        session === undefined ||
        sessions.get(session.tunnelId) !== session ||
        session.socket !== socket
      ) return;
      const current = session;
      const wasActive = current.lifecycle.status === "ACTIVE";
      disposeActivationCandidate(current);
      for (const [streamId, stream] of current.streams) {
        stream.cancelled = true;
        stream.transport.inboundFlow.closeStream(streamId);
        stream.transport.outboundFlow.closeStream(streamId);
        clearGatewayStreamTimers(stream);
        if (stream.kind === "HTTP") {
          if (!stream.response.headersSent) {
            writeGatewayError(stream.response, 503, "TUNNEL_OFFLINE");
          } else {
            stream.response.destroy();
          }
          stream.request.destroy();
        } else {
          stream.browserSocket.destroy();
        }
      }
      current.streams.clear();
      if (current.terminal) {
        metrics.increment("tunnel_closed");
        emit("tunnel.closed", current);
        sessions.delete(current.tunnelId);
        return;
      }
      if (current.lifecycle.status === "CREATING") {
        metrics.increment("activation_failed");
        emit("tunnel.activation_failed", current);
        sessions.delete(current.tunnelId);
        return;
      }
      if (wasActive) {
        const nextLifecycle = transitionSession(
          current.lifecycle,
          { type: "CARRIER_LOST", now: now() },
          sessionPolicy,
        );
        if (!applySessionTransition(current, nextLifecycle)) return;
        metrics.increment("tunnel_reconnecting");
        emit("tunnel.reconnecting", current);
      } else if (current.lifecycle.status === "RECONNECTING") {
        if (
          resumeAttemptId !== undefined &&
          current.lifecycle.candidateAttemptId === resumeAttemptId
        ) {
          const nextLifecycle = transitionSession(current.lifecycle, {
            type: "RESUME_FAILED",
            now: now(),
            attemptId: resumeAttemptId,
          }, sessionPolicy);
          if (!applySessionTransition(current, nextLifecycle)) return;
        }
        metrics.increment("activation_failed");
        emit(
          "tunnel.activation_failed",
          current,
        );
      } else {
        return;
      }
      if (current.expiryTimer !== undefined) clearTimeout(current.expiryTimer);
      if (current.lifecycle.status !== "RECONNECTING") return;
      const reconnectDelay = Math.max(
        0,
        current.lifecycle.disconnectedAt + current.config.snapshot.reconnectGraceMs - now() + 10,
      );
      current.expiryTimer = setTimeout(() => {
        if (
          sessions.get(current.tunnelId) === current &&
          current.lifecycle.status === "RECONNECTING"
        ) {
          current.lifecycle = transitionSession(
            current.lifecycle,
            { type: "TICK", now: now() },
            sessionPolicy,
          );
          if (current.lifecycle.status === "EXPIRED") {
            expireGatewaySession(current, current.lifecycle.reason);
          }
        }
      }, reconnectDelay);
      current.expiryTimer.unref();
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
    socket.once("close", releasePendingCarrier);
    socket.once("error", releasePendingCarrier);
  });

  let activeAuthorizationRevalidations = 0;
  const withRetainedRevalidationAdmission = <T>(
    start: () => Promise<T>,
    timeoutMessage: string,
  ): Promise<T> => {
    if (activeAuthorizationRevalidations >= AUTHORIZATION_REVALIDATION_CONCURRENCY) {
      return Promise.reject(new Error("authorization revalidation capacity exhausted"));
    }
    activeAuthorizationRevalidations += 1;
    let running: Promise<T>;
    try {
      running = start();
    } catch (error) {
      activeAuthorizationRevalidations -= 1;
      throw error;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeAuthorizationRevalidations -= 1;
    };
    retainAdmissionUntilSettled(running, release);
    return withPromiseDeadline(
      running,
      authorizationQueryTimeoutMs,
      timeoutMessage,
    );
  };
  let revocationCheckRunning = false;
  const revocationAuthService = options.authService;
  const revocationTimer = setInterval(() => {
    if (revocationAuthService === undefined || revocationCheckRunning) return;
    revocationCheckRunning = true;
    void (async () => {
      const pendingSessions = [...sessions.values()].filter((session) => !session.terminal);
      const checkAuthorizations = async (
        checks: readonly AccountAuthorizationCheck[],
      ): Promise<readonly PromiseSettledResult<boolean>[]> => {
        if (checks.length === 0) return [];
        const role = checks[0]?.role ?? "DEVELOPER";
        try {
          const results = await withRetainedRevalidationAdmission(
            () => revocationAuthService.areAccountsAuthorized(checks),
            `${role.toLowerCase()} authorization batch query timed out`,
          );
          if (results.length !== checks.length) {
            throw new Error("authorization batch returned an invalid result count");
          }
          return results.map((value) => ({ status: "fulfilled", value }));
        } catch (error) {
          if (error instanceof PromiseDeadlineError) {
            return checks.map(() => ({ status: "rejected", reason: error }));
          }
          const fallbackResults: PromiseSettledResult<boolean>[] = Array(checks.length);
          let nextCheck = 0;
          const workerCount = Math.min(AUTHORIZATION_REVALIDATION_CONCURRENCY, checks.length);
          await Promise.all(Array.from({ length: workerCount }, async () => {
            while (nextCheck < checks.length) {
              const index = nextCheck;
              nextCheck += 1;
              const check = checks[index];
              if (check === undefined) return;
              try {
                const value = await withRetainedRevalidationAdmission(
                  () => revocationAuthService.isAccountAuthorized(
                    check.accountId,
                    check.accountAuthVersion,
                    check.role,
                  ),
                  `${check.role.toLowerCase()} authorization query timed out`,
                );
                fallbackResults[index] = { status: "fulfilled", value };
              } catch (reason) {
                fallbackResults[index] = { status: "rejected", reason };
              }
            }
          }));
          return fallbackResults;
        }
      };
      const developerSnapshots = pendingSessions.flatMap((session) => {
        const accountId = session.ownerAccountId;
        const accountAuthVersion = session.ownerAuthVersion;
        return accountId === undefined || accountAuthVersion === undefined ? [] : [{
          session,
          transport: captureGatewayTransport(session),
          check: { accountId, accountAuthVersion, role: "DEVELOPER" as const },
        }];
      });
      const developerResults = await checkAuthorizations(
        developerSnapshots.map((snapshot) => snapshot.check),
      );
      for (const [index, snapshot] of developerSnapshots.entries()) {
        const result = developerResults[index];
        if (
          result === undefined ||
          !isCurrentGatewaySessionTransport(sessions, snapshot.session, snapshot.transport)
        ) continue;
        if (result.status === "rejected") {
          emit("authorization.revalidation_failed", snapshot.session, {
            reason: toSafeErrorReason(result.reason),
          });
          snapshot.session.terminal = true;
          snapshot.transport.socket.close(1011, "authorization revalidation unavailable");
        } else if (!result.value) {
          snapshot.session.terminal = true;
          snapshot.transport.socket.close(1008, "developer authorization revoked");
        }
      }
      const reviewerSnapshots = pendingSessions.flatMap((session) => {
        const transport = captureGatewayTransport(session);
        if (!isCurrentGatewaySessionTransport(sessions, session, transport)) return [];
        return [...session.streams.entries()].flatMap(([streamId, stream]) => {
          const accountId = stream.reviewerAccountId;
          const accountAuthVersion = stream.reviewerAuthVersion;
          return accountId === undefined || accountAuthVersion === undefined ? [] : [{
            session,
            streamId,
            stream,
            check: { accountId, accountAuthVersion, role: "REVIEWER" as const },
          }];
        });
      });
      const reviewerResults = await checkAuthorizations(
        reviewerSnapshots.map((snapshot) => snapshot.check),
      );
      for (const [index, snapshot] of reviewerSnapshots.entries()) {
        const result = reviewerResults[index];
        if (
          result === undefined ||
          !isCurrentGatewaySessionStream(
            sessions,
            snapshot.session,
            snapshot.streamId,
            snapshot.stream,
          )
        ) continue;
        if (result.status === "fulfilled" && result.value) continue;
        if (result.status === "rejected") {
          emit("authorization.revalidation_failed", snapshot.session, {
            reason: toSafeErrorReason(result.reason),
          });
        }
        snapshot.stream.cancelled = true;
        removeGatewayStream(
          snapshot.session,
          snapshot.streamId,
          snapshot.stream,
          "LOCAL_RESET",
        );
        snapshot.stream.transport.outboundFlow.closeStream(snapshot.streamId);
        if (snapshot.stream.kind === "HTTP") {
          snapshot.stream.response.destroy();
          snapshot.stream.request.destroy();
        } else snapshot.stream.browserSocket.destroy();
        void sendReset(
          snapshot.stream.transport,
          snapshot.streamId,
          result.status === "rejected"
            ? "AUTHORIZATION_UNAVAILABLE"
            : "AUTHORIZATION_REVOKED",
        );
      }
    })()
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: "authorization_revalidation_loop_failed",
          reason: toSafeErrorReason(error),
        }));
        for (const session of sessions.values()) {
          emit("authorization.revalidation_failed", session, {
            reason: toSafeErrorReason(error),
          });
          session.terminal = true;
          session.socket.close(1011, "authorization revalidation unavailable");
        }
      })
      .finally(() => {
        revocationCheckRunning = false;
      });
  }, options.authorizationCheckIntervalMs ?? 5_000);
  revocationTimer.unref();
  let authCleanupRunning = false;
  const authCleanupTimer = setInterval(() => {
    if (options.authService === undefined || authCleanupRunning) return;
    authCleanupRunning = true;
    let cleanup: Promise<void>;
    try {
      cleanup = options.authService.cleanupExpiredArtifacts();
    } catch (error) {
      authCleanupRunning = false;
      console.error(JSON.stringify({
        event: "auth_cleanup_failed",
        reason: toSafeErrorReason(error),
      }));
      return;
    }
    const releaseCleanupAdmission = () => {
      authCleanupRunning = false;
    };
    retainAdmissionUntilSettled(cleanup, releaseCleanupAdmission);
    void withPromiseDeadline(
      cleanup,
      authCleanupTimeoutMs,
      "auth cleanup timed out",
    ).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "auth_cleanup_failed",
        reason: toSafeErrorReason(error),
      }));
    });
  }, 10 * 60_000);
  authCleanupTimer.unref();

  const heartbeatTimer = setInterval(() => {
    const checkedAt = now();
    for (const session of sessions.values()) {
      const transport = captureGatewayTransport(session);
      if (transport.socket.readyState !== WebSocket.OPEN) continue;
      if (checkedAt - session.lastPongAt >= carrierLeaseMs) {
        transport.socket.close(1001, "carrier lease expired");
        continue;
      }
      void sendCarrierFrame(transport.socket, {
        type: FrameType.Ping,
        generation: transport.generation,
        streamId: 0,
      }).catch(() => {
        if (isCurrentGatewaySessionTransport(sessions, session, transport)) {
          transport.socket.close(1011, "heartbeat failed");
        }
      });
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  const sessionTimer = setInterval(() => {
    const checkedAt = now();
    for (const session of sessions.values()) {
      if (
        session.lifecycle.status !== "ACTIVE" &&
        session.lifecycle.status !== "RECONNECTING"
      ) continue;
      const wasReconnecting = session.lifecycle.status === "RECONNECTING";
      const nextLifecycle = transitionSession(
        session.lifecycle,
        { type: "TICK", now: checkedAt },
        sessionPolicy,
      );
      const developerAuthorizationExpired =
        checkedAt >= session.developerAuthorizedAt + authorizationMaxAgeMs;
      if (nextLifecycle.status === "EXPIRED" || developerAuthorizationExpired) {
        session.lifecycle = nextLifecycle;
        expireGatewaySession(
          session,
          developerAuthorizationExpired
            ? "AUTHORIZATION_EXPIRED"
            : nextLifecycle.status === "EXPIRED"
              ? nextLifecycle.reason
              : "UNKNOWN",
        );
        continue;
      }
      if (wasReconnecting) continue;
      for (const [streamId, stream] of session.streams) {
        if (
          stream.reviewerAuthorizedAt === undefined ||
          checkedAt < stream.reviewerAuthorizedAt + authorizationMaxAgeMs
        ) {
          continue;
        }
        stream.cancelled = true;
        removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
        stream.transport.outboundFlow.closeStream(streamId);
        if (stream.kind === "HTTP") {
          stream.response.destroy();
          stream.request.destroy();
        } else stream.browserSocket.destroy();
        void sendReset(stream.transport, streamId, "AUTHORIZATION_EXPIRED");
      }
    }
  }, sessionTickIntervalMs);
  sessionTimer.unref();

  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.listen(port, host, resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Gateway did not bind a TCP port");
      }
      return address.port;
    },
    async close() {
      clearInterval(revocationTimer);
      clearInterval(authCleanupTimer);
      clearInterval(heartbeatTimer);
      clearInterval(sessionTimer);
      for (const session of sessions.values()) {
        if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
        if (session.configAckTimer !== undefined) clearTimeout(session.configAckTimer);
        session.outboundFlow.close();
      }
      sessions.clear();
      credentialReservations.clear();
      for (const socket of carriers.clients) socket.terminate();
      for (const socket of canaryWebSockets.clients) socket.terminate();
      for (const socket of serverSockets) socket.destroy();
      await closeHttpServer(server);
      await new Promise<void>((resolve) => carriers.close(() => resolve()));
      await new Promise<void>((resolve) => canaryWebSockets.close(() => resolve()));
    },
    setKillSwitch(enabled) {
      updateKillSwitch(enabled);
    },
    isKillSwitchEnabled() {
      return killSwitchEnabled;
    },
    metrics() {
      return metrics.render(metricSnapshot());
    },
  };

  function updateKillSwitch(enabled: boolean): void {
    if (killSwitchEnabled === enabled) return;
    killSwitchEnabled = enabled;
    metrics.increment("kill_switch_changed");
    emit(enabled ? "kill_switch.enabled" : "kill_switch.disabled");
    if (!enabled) return;
    for (const session of sessions.values()) {
      session.terminal = true;
      for (const [streamId, stream] of session.streams) {
        stream.cancelled = true;
        removeGatewayStream(session, streamId, stream);
        stream.transport.outboundFlow.closeStream(streamId);
        if (stream.kind === "HTTP") {
          stream.response.destroy();
          stream.request.destroy();
        } else stream.browserSocket.destroy();
      }
      session.socket.close(1008, "operational kill switch");
    }
  }

  function expireGatewaySession(session: GatewaySession, reason: string): void {
    if (sessions.get(session.tunnelId) !== session) return;
    session.terminal = true;
    if (session.expiryTimer !== undefined) {
      clearTimeout(session.expiryTimer);
      delete session.expiryTimer;
    }
    disposeActivationCandidate(session);
    for (const [streamId, stream] of session.streams) {
      stream.cancelled = true;
      stream.transport.inboundFlow.closeStream(streamId);
      stream.transport.outboundFlow.closeStream(streamId);
      clearGatewayStreamTimers(stream);
      if (stream.kind === "HTTP") {
        if (!stream.response.headersSent) {
          writeGatewayError(stream.response, 503, "TUNNEL_EXPIRED");
        } else {
          stream.response.destroy();
        }
        stream.request.destroy();
      } else {
        stream.browserSocket.destroy();
      }
    }
    session.streams.clear();
    session.outboundFlow.close();
    sessions.delete(session.tunnelId);
    metrics.increment("tunnel_expired");
    emit("tunnel.expired", session, { reason });
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.close(1008, "session expired");
    }
  }

  function applySessionTransition(
    session: GatewaySession,
    nextLifecycle: SessionState,
  ): boolean {
    session.lifecycle = nextLifecycle;
    if (nextLifecycle.status !== "EXPIRED") return true;
    expireGatewaySession(session, nextLifecycle.reason);
    return false;
  }

  function metricSnapshot() {
    let activeTunnels = 0;
    let reconnectingTunnels = 0;
    let activeStreams = 0;
    for (const session of sessions.values()) {
      if (session.lifecycle.status === "ACTIVE") activeTunnels += 1;
      else if (session.lifecycle.status === "RECONNECTING") reconnectingTunnels += 1;
      activeStreams += session.streams.size;
    }
    return {
      activeTunnels,
      reconnectingTunnels,
      activeStreams,
      killSwitchEnabled,
      admissionReady: !killSwitchEnabled && gatewayAdmissionReady(),
    };
  }

  function canAdmitNewTunnel(
    accountId: string | undefined,
    _excludedTunnelId?: string,
  ): boolean {
    cleanupCredentialReservations();
    let pending = pendingCarrierConnections;
    let active = 0;
    let owned = 0;
    for (const session of sessions.values()) {
      if (session.terminal) continue;
      if (session.lifecycle.status === "CREATING") pending += 1;
      else if (
        session.lifecycle.status === "ACTIVE" ||
        session.lifecycle.status === "RECONNECTING"
      ) active += 1;
      if (accountId !== undefined && session.ownerAccountId === accountId) owned += 1;
    }
    for (const reservation of credentialReservations.values()) {
      pending += 1;
      if (accountId !== undefined && reservation.accountId === accountId) owned += 1;
    }
    return pending < maxPendingTunnels &&
      active < maxActiveTunnels &&
      (accountId === undefined || owned < maxTunnelsPerAccount);
  }

  function canActivateTunnel(candidate: GatewaySession): boolean {
    let active = 0;
    let owned = 0;
    for (const session of sessions.values()) {
      if (session === candidate || session.terminal) continue;
      if (
        session.lifecycle.status === "ACTIVE" ||
        session.lifecycle.status === "RECONNECTING"
      ) active += 1;
      if (
        candidate.ownerAccountId !== undefined &&
        session.ownerAccountId === candidate.ownerAccountId
      ) owned += 1;
    }
    return active < maxActiveTunnels &&
      (candidate.ownerAccountId === undefined || owned < maxTunnelsPerAccount);
  }

  function cleanupCredentialReservations(): void {
    const checkedAt = now();
    for (const [reservationId, reservation] of credentialReservations) {
      if (reservation.expiresAt <= checkedAt) {
        credentialReservations.delete(reservationId);
      }
    }
  }

  function consumeCredentialReservation(
    authorization: DeveloperAuthorization,
  ): void {
    cleanupCredentialReservations();
    for (const [reservationId, reservation] of credentialReservations) {
      if (
        reservation.accountId === authorization.accountId &&
        reservation.purpose === authorization.purpose &&
        reservation.tunnelId === authorization.tunnelId
      ) {
        credentialReservations.delete(reservationId);
        return;
      }
    }
  }

  function reservePendingCarrierConnection(): (() => void) | undefined {
    cleanupCredentialReservations();
    if (!hasPendingTunnelCapacity()) return undefined;
    pendingCarrierConnections += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingCarrierConnections -= 1;
    };
  }

  function hasPendingTunnelCapacity(): boolean {
    let occupiedPendingSlots = pendingCarrierConnections + credentialReservations.size;
    for (const session of sessions.values()) {
      if (!session.terminal && session.lifecycle.status === "CREATING") {
        occupiedPendingSlots += 1;
      }
    }
    return occupiedPendingSlots < maxPendingTunnels;
  }

  function reserveCarrierAuthorizationAttempt(): (() => void) | undefined {
    if (carrierAuthorizationAttempts >= maxPendingTunnels) return undefined;
    carrierAuthorizationAttempts += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      carrierAuthorizationAttempts -= 1;
    };
  }
}

async function handleReviewerRequest(
  sessions: ReadonlyMap<string, GatewaySession>,
  tunnelId: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  reviewer?: Principal,
): Promise<void> {
  if (
    request.destroyed ||
    request.socket.destroyed ||
    response.destroyed ||
    response.writableEnded
  ) return;
  const session = tunnelId === undefined ? undefined : sessions.get(tunnelId);
  if (
    session === undefined ||
    session.lifecycle.status !== "ACTIVE" ||
    session.socket.readyState !== WebSocket.OPEN
  ) {
    writeGatewayError(
      response,
      reviewer !== undefined && session === undefined ? 404 : 503,
      reviewer !== undefined && session === undefined ? "NOT_FOUND" : "TUNNEL_OFFLINE",
    );
    return;
  }
  if (!admitStream(session)) {
    response.setHeader("Retry-After", "1");
    writeGatewayError(response, 429, "STREAM_LIMIT_EXCEEDED");
    return;
  }
  const declaredRequestBytes = parseContentLength(request.headers["content-length"]);
  if (
    declaredRequestBytes !== undefined &&
    declaredRequestBytes > session.config.snapshot.maxRequestBodyBytes
  ) {
    writeGatewayError(response, 413, "REQUEST_TOO_LARGE");
    return;
  }

  const streamId = session.streamIds.issue();
  const transport = captureGatewayTransport(session);
  const stream: GatewayHttpStream = {
    kind: "HTTP",
    transport,
    request,
    response,
    requestEnded: false,
    responseEnded: false,
    responseBytes: 0,
    finiteResponse: false,
    responseBodyAllowed: false,
    downstreamQueuedFrames: 0,
    downstreamQueue: Promise.resolve(),
    cancelled: false,
    ...(reviewer === undefined ? {} : {
      reviewerAccountId: reviewer.accountId,
      reviewerAuthVersion: reviewer.authVersion,
      reviewerAuthorizedAt: session.now(),
    }),
  };
  if (!beginGatewayStream(session)) {
    writeGatewayError(response, 503, "TUNNEL_EXPIRED");
    return;
  }
  session.streams.set(streamId, stream);
  session.metrics.increment("stream_opened");
  const expireStream = (code: string) => {
    if (
      stream.cancelled ||
      !isCurrentGatewaySessionStream(sessions, session, streamId, stream)
    ) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
    transport.outboundFlow.closeStream(streamId);
    if (!response.headersSent) writeGatewayError(response, 408, code);
    else response.destroy();
    request.destroy();
    void sendReset(transport, streamId, code);
  };
  stream.durationTimer = setTimeout(
    () => expireStream("LIMIT_EXCEEDED"),
    session.config.snapshot.maxStreamDurationMs,
  );
  stream.durationTimer.unref();
  touchRequestInactivity(stream, session.config.snapshot.streamInactivityTimeoutMs, expireStream);
  transport.outboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);
  transport.inboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);

  response.once("close", () => {
    if (
      stream.responseEnded ||
      stream.cancelled ||
      !isCurrentGatewaySessionStream(sessions, session, streamId, stream)
    ) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
    transport.outboundFlow.closeStream(streamId);
    void sendReset(transport, streamId, "DOWNSTREAM_CANCELLED");
  });

  try {
    await sendCarrierFrame(transport.socket, {
      type: FrameType.OpenHttp,
      generation: transport.generation,
      streamId,
      payload: encodeMetadata({
        kind: "HTTP",
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: isolateGatewayCredentials(
          sanitizeHopByHopHeaders(
            stripUntrustedForwardingHeaders(rawHeadersToPairs(request.rawHeaders)),
          ),
          RESERVED_GATEWAY_COOKIES,
        ),
        requestBodyEnded: false,
        initialWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
      }),
    });

    let requestBytes = 0;
    for await (const chunk of request) {
      if (
        stream.cancelled ||
        !isCurrentGatewaySessionStream(sessions, session, streamId, stream)
      ) return;
      touchRequestInactivity(
        stream,
        session.config.snapshot.streamInactivityTimeoutMs,
        expireStream,
      );
      requestBytes += chunk.byteLength;
      if (requestBytes > session.config.snapshot.maxRequestBodyBytes) {
        stream.cancelled = true;
        removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
        transport.outboundFlow.closeStream(streamId);
        if (!response.headersSent) writeGatewayError(response, 413, "REQUEST_TOO_LARGE");
        else response.destroy();
        await sendReset(transport, streamId, "REQUEST_TOO_LARGE");
        return;
      }
      await sendFlowControlledData(transport.socket, transport.outboundFlow, {
        generation: transport.generation,
        streamId,
        chunk,
      });
    }
    if (
      stream.cancelled ||
      !isCurrentGatewaySessionStream(sessions, session, streamId, stream)
    ) return;
    clearRequestInactivityTimer(stream);
    stream.requestEnded = true;
    await sendCarrierFrame(transport.socket, {
      type: FrameType.EndStream,
      generation: transport.generation,
      streamId,
    });
    if (!isCurrentGatewaySessionStream(sessions, session, streamId, stream)) return;
    maybeDeleteStream(session, streamId, stream);
  } catch {
    if (!isCurrentGatewaySessionStream(sessions, session, streamId, stream)) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
    transport.outboundFlow.closeStream(streamId);
    if (!response.headersSent) writeGatewayError(response, 502, "RELAY_WRITE_FAILED");
    else response.destroy();
    await sendReset(transport, streamId, "RELAY_WRITE_FAILED");
  }
}

async function handleClientFrame(
  session: GatewaySession,
  envelope: ReturnType<typeof decodeEnvelope>,
): Promise<void> {
  if (isRetiredGatewayStream(session, envelope.streamId)) {
    validateRetiredClientFrame(envelope, session.inboundFlow);
    return;
  }
  const stream = session.streams.get(envelope.streamId);
  if (stream === undefined || stream.cancelled) {
    throw new Error(`frame for unknown or retired stream ${envelope.streamId}`);
  }
  if (envelope.type === FrameType.WindowUpdate) {
    stream.transport.outboundFlow.update(
      envelope.streamId,
      decodeWindowUpdate(envelope.payload),
    );
    return;
  }

  if (stream.kind === "WEBSOCKET") {
    await handleWebSocketClientFrame(session, envelope.streamId, stream, envelope);
    return;
  }

  switch (envelope.type) {
    case FrameType.ResponseHeaders: {
      if (stream.response.headersSent) throw new Error("duplicate response headers");
      const metadata = decodeResponseHeadersMetadata(envelope.payload);
      const declaredResponseBytes = contentLengthFromPairs(metadata.headers);
      stream.responseBodyAllowed = responseCanHaveBody(
        stream.request.method,
        metadata.statusCode,
      );
      stream.finiteResponse = stream.responseBodyAllowed && isFiniteHttpResponse(metadata.headers);
      if (
        stream.finiteResponse &&
        declaredResponseBytes !== undefined &&
        declaredResponseBytes > session.config.snapshot.maxFiniteResponseBytes
      ) {
        stream.cancelled = true;
        removeGatewayStream(session, envelope.streamId, stream, "LOCAL_RESET");
        stream.transport.outboundFlow.closeStream(envelope.streamId);
        writeGatewayError(stream.response, 502, "UPSTREAM_RESPONSE_TOO_LARGE");
        stream.request.destroy();
        await sendReset(
          stream.transport,
          envelope.streamId,
          "UPSTREAM_RESPONSE_TOO_LARGE",
        );
        return;
      }
      stream.response.writeHead(
        metadata.statusCode,
        metadata.statusMessage,
        headerPairsToOutgoingHeaders(isolateGatewayCredentials(
          sanitizeHopByHopHeaders(metadata.headers),
          RESERVED_GATEWAY_COOKIES,
        )),
      );
      break;
    }
    case FrameType.Data: {
      if (!stream.response.headersSent) throw new Error("DATA before response headers");
      if (!stream.responseBodyAllowed) throw new Error("DATA is forbidden for this response");
      const chunk = reserveInboundChunk(
        session,
        envelope.streamId,
        stream,
        envelope.payload,
      );
      stream.responseBytes += envelope.payload.byteLength;
      if (
        stream.finiteResponse &&
        stream.responseBytes > session.config.snapshot.maxFiniteResponseBytes
      ) {
        stream.cancelled = true;
        removeGatewayStream(session, envelope.streamId, stream, "LOCAL_RESET");
        stream.transport.outboundFlow.closeStream(envelope.streamId);
        stream.response.destroy();
        stream.request.destroy();
        await sendReset(
          stream.transport,
          envelope.streamId,
          "UPSTREAM_RESPONSE_TOO_LARGE",
        );
        return;
      }
      enqueueHttpResponseData(session, envelope.streamId, stream, chunk);
      break;
    }
    case FrameType.EndStream: {
      if (!stream.response.headersSent) throw new Error("END before response headers");
      if (stream.responseEnded) throw new Error("duplicate response END");
      stream.responseEnded = true;
      enqueueHttpResponseEnd(session, envelope.streamId, stream);
      break;
    }
    case FrameType.ResetStream: {
      const reset = decodeResetStreamMetadata(envelope.payload);
      stream.cancelled = true;
      removeGatewayStream(session, envelope.streamId, stream);
      stream.transport.outboundFlow.closeStream(envelope.streamId);
      if (!stream.response.headersSent) {
        writeGatewayError(stream.response, 502, reset.code);
      } else {
        stream.response.destroy();
      }
      stream.request.destroy();
      break;
    }
    default:
      throw new Error(`unexpected client frame type ${envelope.type}`);
  }
}

function isRetiredGatewayStream(
  session: GatewaySession,
  streamId: number,
): boolean {
  return session.streamIds.wasIssued(streamId) &&
    !session.streams.has(streamId) &&
    session.probe?.streamId !== streamId;
}

function validateRetiredClientFrame(
  envelope: ReturnType<typeof decodeEnvelope>,
  inboundFlow: GatewayInboundFlow,
): void {
  switch (envelope.type) {
    case FrameType.ResponseHeaders:
      decodeResponseHeadersMetadata(envelope.payload);
      return;
    case FrameType.Data:
      if (envelope.payload.byteLength === 0) {
        throw new Error("inbound DATA payload must not be empty");
      }
      inboundFlow.consumeRetiredData(envelope.streamId, envelope.payload.byteLength);
      return;
    case FrameType.EndStream:
      return;
    case FrameType.WindowUpdate:
      decodeWindowUpdate(envelope.payload);
      return;
    case FrameType.ResetStream:
      decodeResetStreamMetadata(envelope.payload);
      return;
    default:
      throw new Error(`unexpected retired client frame type ${envelope.type}`);
  }
}

function enqueueHttpResponseData(
  session: GatewaySession,
  streamId: number,
  stream: GatewayHttpStream,
  chunk: Buffer,
): void {
  stream.downstreamQueue = stream.downstreamQueue
    .then(async () => {
      if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
      if (!stream.response.write(chunk)) await waitForWritableDrain(stream.response);
      if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
      await sendWindowUpdate(stream.transport, streamId, chunk.byteLength);
      if (!isCurrentGatewayStream(session, streamId, stream)) return;
      stream.transport.inboundFlow.release(streamId, chunk.byteLength);
      stream.downstreamQueuedFrames -= 1;
    })
    .catch((error: unknown) => {
      failBufferedDownstream(session, streamId, stream, error);
    });
}

function enqueueHttpResponseEnd(
  session: GatewaySession,
  streamId: number,
  stream: GatewayHttpStream,
): void {
  stream.downstreamQueue = stream.downstreamQueue
    .then(() => {
      if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
      stream.response.end();
      maybeDeleteStream(session, streamId, stream);
    })
    .catch((error: unknown) => {
      failBufferedDownstream(session, streamId, stream, error);
    });
}

function reserveInboundChunk(
  session: GatewaySession,
  streamId: number,
  stream: GatewayHttpStream | GatewayWebSocketStream,
  payload: Uint8Array,
): Buffer {
  if (payload.byteLength === 0) {
    throw new Error("inbound DATA payload must not be empty");
  }
  if (stream.downstreamQueuedFrames >= MAX_PENDING_DOWNSTREAM_FRAMES) {
    throw new Error("inbound DATA frame queue exceeds configured bound");
  }
  if (!isCurrentGatewayStream(session, streamId, stream)) {
    throw new Error("cannot buffer data for a stale Gateway stream");
  }
  stream.transport.inboundFlow.consume(streamId, payload.byteLength);
  stream.downstreamQueuedFrames += 1;
  return Buffer.from(payload);
}

function failBufferedDownstream(
  session: GatewaySession,
  streamId: number,
  stream: GatewayHttpStream | GatewayWebSocketStream,
  _error: unknown,
): void {
  if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
  stream.cancelled = true;
  removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
  stream.transport.outboundFlow.closeStream(streamId);
  if (stream.kind === "HTTP") {
    stream.response.destroy();
    stream.request.destroy();
  } else stream.browserSocket.destroy();
  void sendReset(stream.transport, streamId, "DOWNSTREAM_WRITE_FAILED");
}

function waitForWritableDrain(target: ServerResponse | Duplex): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("downstream closed before drain"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      target.off("drain", onDrain);
      target.off("close", onClose);
      target.off("error", onError);
    };
    target.once("drain", onDrain);
    target.once("close", onClose);
    target.once("error", onError);
  });
}

function maybeDeleteStream(
  session: GatewaySession,
  streamId: number,
  stream: GatewayHttpStream,
): void {
  if (!stream.requestEnded || !stream.responseEnded) return;
  if (removeGatewayStream(session, streamId, stream)) {
    stream.transport.outboundFlow.closeStream(streamId);
  }
}

function removeGatewayStream(
  session: GatewaySession,
  streamId: number,
  stream: GatewayStream,
  retirement: "LOCAL_RESET" | "NORMAL" = "NORMAL",
): boolean {
  if (!isCurrentGatewayStream(session, streamId, stream)) return false;
  if (!session.streams.delete(streamId)) return false;
  if (retirement === "LOCAL_RESET") stream.transport.inboundFlow.retireStream(streamId);
  else stream.transport.inboundFlow.closeStream(streamId);
  clearGatewayStreamTimers(stream);
  if (session.lifecycle.status === "ACTIVE") {
    const nextLifecycle = transitionSession(session.lifecycle, {
      type: "STREAM_CLOSED",
      now: session.now(),
    }, session.policy);
    session.lifecycle = nextLifecycle;
    if (nextLifecycle.status === "EXPIRED") {
      session.disposeExpired(session, nextLifecycle.reason);
    }
  }
  return true;
}

function beginGatewayStream(session: GatewaySession): boolean {
  const nextLifecycle = transitionSession(session.lifecycle, {
    type: "STREAM_OPEN",
    now: session.now(),
  }, session.policy);
  session.lifecycle = nextLifecycle;
  if (nextLifecycle.status === "EXPIRED") {
    session.disposeExpired(session, nextLifecycle.reason);
    return false;
  }
  if (nextLifecycle.status !== "ACTIVE") {
    throw new Error(`cannot open stream from ${nextLifecycle.status} session`);
  }
  return true;
}

function touchRequestInactivity(
  stream: GatewayHttpStream,
  timeoutMs: number,
  expire: (code: string) => void,
): void {
  if (stream.requestInactivityTimer !== undefined) {
    clearTimeout(stream.requestInactivityTimer);
  }
  stream.requestInactivityTimer = setTimeout(() => expire("IDLE_TIMEOUT"), timeoutMs);
  stream.requestInactivityTimer.unref();
}

function clearRequestInactivityTimer(stream: GatewayHttpStream): void {
  if (stream.requestInactivityTimer === undefined) return;
  clearTimeout(stream.requestInactivityTimer);
  delete stream.requestInactivityTimer;
}

function clearGatewayStreamTimers(stream: GatewayStream): void {
  if (stream.durationTimer !== undefined) clearTimeout(stream.durationTimer);
  delete stream.durationTimer;
  if (stream.kind === "HTTP") clearRequestInactivityTimer(stream);
}

function admitStream(session: GatewaySession): boolean {
  const limits = session.config.snapshot;
  if (session.streams.size >= limits.maxConcurrentStreams) {
    session.metrics.increment("stream_rejected");
    return false;
  }
  const checkedAt = session.now();
  if (checkedAt - session.streamRateWindowStartedAt >= 60_000) {
    session.streamRateWindowStartedAt = checkedAt;
    session.streamsOpenedInWindow = 0;
  }
  if (session.streamsOpenedInWindow >= limits.maxNewStreamsPerMinute) {
    session.metrics.increment("stream_rejected");
    return false;
  }
  session.streamsOpenedInWindow += 1;
  return true;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function contentLengthFromPairs(headers: readonly (readonly [string, string])[]): number | undefined {
  const values = headers
    .filter(([name]) => name.toLowerCase() === "content-length")
    .map(([, value]) => parseContentLength(value));
  if (values.length !== 1) return undefined;
  return values[0];
}

function isFiniteHttpResponse(
  headers: readonly (readonly [string, string])[],
): boolean {
  const contentType = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1]
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType === "text/event-stream") return false;
  return true;
}

function responseCanHaveBody(method: string | undefined, statusCode: number): boolean {
  return method !== "HEAD" &&
    !(statusCode >= 100 && statusCode < 200) &&
    statusCode !== 204 &&
    statusCode !== 304;
}

async function handleReviewerUpgrade(
  sessions: ReadonlyMap<string, GatewaySession>,
  tunnelId: string | undefined,
  request: IncomingMessage,
  browserSocket: Duplex,
  head: Buffer,
  reviewer?: Principal,
): Promise<void> {
  if (
    browserSocket.destroyed ||
    !browserSocket.readable ||
    !browserSocket.writable ||
    browserSocket.readableEnded ||
    browserSocket.writableEnded
  ) return;
  const session = tunnelId === undefined ? undefined : sessions.get(tunnelId);
  if (
    session === undefined ||
    session.lifecycle.status !== "ACTIVE" ||
    session.socket.readyState !== WebSocket.OPEN
  ) {
    writeRawError(
      browserSocket,
      reviewer !== undefined && session === undefined ? 404 : 503,
      reviewer !== undefined && session === undefined ? "NOT_FOUND" : "TUNNEL_OFFLINE",
    );
    return;
  }
  if ((request.url ?? "/").startsWith("/_review-tunnel/")) {
    writeRawError(browserSocket, 404, "NOT_FOUND");
    return;
  }
  if (!admitStream(session)) {
    writeRawError(browserSocket, 429, "STREAM_LIMIT_EXCEEDED");
    return;
  }
  if (head.byteLength > 64 * 1024) {
    writeRawError(browserSocket, 413, "UPGRADE_HEAD_TOO_LARGE");
    return;
  }

  browserSocket.pause();
  const streamId = session.streamIds.issue();
  const transport = captureGatewayTransport(session);
  const stream: GatewayWebSocketStream = {
    kind: "WEBSOCKET",
    transport,
    browserSocket,
    pendingHead: head,
    responseStarted: false,
    upgraded: false,
    browserEnded: false,
    localEnded: false,
    downstreamQueuedFrames: 0,
    downstreamQueue: Promise.resolve(),
    cancelled: false,
    ...(reviewer === undefined ? {} : {
      reviewerAccountId: reviewer.accountId,
      reviewerAuthVersion: reviewer.authVersion,
      reviewerAuthorizedAt: session.now(),
    }),
  };
  if (!beginGatewayStream(session)) {
    writeRawError(browserSocket, 503, "TUNNEL_EXPIRED");
    return;
  }
  session.streams.set(streamId, stream);
  session.metrics.increment("stream_opened");
  stream.durationTimer = setTimeout(() => {
    if (
      stream.cancelled ||
      !isCurrentGatewaySessionStream(sessions, session, streamId, stream)
    ) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
    transport.outboundFlow.closeStream(streamId);
    browserSocket.destroy();
    void sendReset(transport, streamId, "LIMIT_EXCEEDED");
  }, session.config.snapshot.maxStreamDurationMs);
  stream.durationTimer.unref();
  transport.outboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);
  transport.inboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);

  const cancel = () => {
    if (
      stream.cancelled ||
      (stream.upgraded && stream.browserEnded) ||
      !isCurrentGatewaySessionStream(sessions, session, streamId, stream)
    ) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
    transport.outboundFlow.closeStream(streamId);
    void sendReset(transport, streamId, "DOWNSTREAM_CANCELLED");
  };
  browserSocket.once("error", cancel);
  browserSocket.once("close", cancel);

  try {
    await sendCarrierFrame(transport.socket, {
      type: FrameType.OpenHttp,
      generation: transport.generation,
      streamId,
      payload: encodeMetadata({
        kind: "WEBSOCKET",
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: isolateGatewayCredentials(
          sanitizeHopByHopHeaders(
            stripUntrustedForwardingHeaders(rawHeadersToPairs(request.rawHeaders)),
          ),
          RESERVED_GATEWAY_COOKIES,
        ),
        requestBodyEnded: true,
        initialWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
      }),
    });
  } catch {
    if (!isCurrentGatewaySessionStream(sessions, session, streamId, stream)) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
    transport.outboundFlow.closeStream(streamId);
    writeRawError(browserSocket, 502, "RELAY_WRITE_FAILED");
    await sendReset(transport, streamId, "RELAY_WRITE_FAILED");
  }
}

async function handleWebSocketClientFrame(
  session: GatewaySession,
  streamId: number,
  stream: GatewayWebSocketStream,
  envelope: ReturnType<typeof decodeEnvelope>,
): Promise<void> {
  switch (envelope.type) {
    case FrameType.ResponseHeaders: {
      if (stream.responseStarted) throw new Error("duplicate response headers");
      const metadata = decodeResponseHeadersMetadata(envelope.payload);
      stream.responseStarted = true;
      stream.browserSocket.write(serializeRawHeaders(metadata));
      if (metadata.statusCode === 101) {
        stream.upgraded = true;
        if (stream.pendingHead.byteLength > 0) {
          try {
            await sendFlowControlledData(
              stream.transport.socket,
              stream.transport.outboundFlow,
              {
                generation: stream.transport.generation,
                streamId,
                chunk: stream.pendingHead,
              },
            );
          } catch {
            if (
              stream.cancelled ||
              !isCurrentGatewayStream(session, streamId, stream)
            ) return;
            stream.cancelled = true;
            removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
            stream.transport.outboundFlow.closeStream(streamId);
            stream.browserSocket.destroy();
            void sendReset(stream.transport, streamId, "RELAY_WRITE_FAILED");
            return;
          }
          if (!isCurrentGatewayStream(session, streamId, stream)) return;
        }
        attachBrowserRawForwarding(session, streamId, stream);
        stream.browserSocket.resume();
      }
      break;
    }
    case FrameType.Data:
      if (!stream.responseStarted) throw new Error("DATA before response headers");
      enqueueWebSocketResponseData(session, streamId, stream, envelope.payload);
      break;
    case FrameType.EndStream:
      if (!stream.responseStarted) throw new Error("END before response headers");
      if (stream.localEnded) throw new Error("duplicate WebSocket response END");
      stream.localEnded = true;
      enqueueWebSocketResponseEnd(session, streamId, stream);
      break;
    case FrameType.ResetStream: {
      stream.cancelled = true;
      removeGatewayStream(session, streamId, stream);
      stream.transport.outboundFlow.closeStream(streamId);
      stream.browserSocket.destroy();
      break;
    }
    default:
      throw new Error(`unexpected WebSocket client frame type ${envelope.type}`);
  }
}

function enqueueWebSocketResponseData(
  session: GatewaySession,
  streamId: number,
  stream: GatewayWebSocketStream,
  payload: Uint8Array,
): void {
  const chunk = reserveInboundChunk(session, streamId, stream, payload);
  stream.downstreamQueue = stream.downstreamQueue
    .then(async () => {
      if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
      if (!stream.browserSocket.write(chunk)) {
        await waitForWritableDrain(stream.browserSocket);
      }
      if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
      await sendWindowUpdate(stream.transport, streamId, chunk.byteLength);
      if (!isCurrentGatewayStream(session, streamId, stream)) return;
      stream.transport.inboundFlow.release(streamId, chunk.byteLength);
      stream.downstreamQueuedFrames -= 1;
    })
    .catch((error: unknown) => {
      failBufferedDownstream(session, streamId, stream, error);
    });
}

function enqueueWebSocketResponseEnd(
  session: GatewaySession,
  streamId: number,
  stream: GatewayWebSocketStream,
): void {
  stream.downstreamQueue = stream.downstreamQueue
    .then(() => {
      if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
      stream.browserSocket.end();
      if (!stream.upgraded || stream.browserEnded) {
        removeGatewayStream(session, streamId, stream);
        stream.transport.outboundFlow.closeStream(streamId);
      }
    })
    .catch((error: unknown) => {
      failBufferedDownstream(session, streamId, stream, error);
    });
}

function attachBrowserRawForwarding(
  session: GatewaySession,
  streamId: number,
  stream: GatewayWebSocketStream,
): void {
  let sendQueue = Promise.resolve();
  stream.browserSocket.on("data", (chunk: Buffer) => {
    stream.browserSocket.pause();
    sendQueue = sendQueue
      .then(() => {
        if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
        return sendFlowControlledData(
          stream.transport.socket,
          stream.transport.outboundFlow,
          {
            generation: stream.transport.generation,
            streamId,
            chunk,
          },
        );
      })
      .then(() => {
        if (
          !stream.cancelled &&
          !stream.browserEnded &&
          isCurrentGatewayStream(session, streamId, stream)
        ) stream.browserSocket.resume();
      })
      .catch(() => {
        if (!isCurrentGatewayStream(session, streamId, stream)) return;
        stream.cancelled = true;
        removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
        stream.transport.outboundFlow.closeStream(streamId);
        stream.browserSocket.destroy();
        void sendReset(stream.transport, streamId, "RELAY_WRITE_FAILED");
      });
  });
  stream.browserSocket.once("end", () => {
    sendQueue = sendQueue
      .then(async () => {
        if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
        stream.browserEnded = true;
        await sendCarrierFrame(stream.transport.socket, {
          type: FrameType.EndStream,
          generation: stream.transport.generation,
          streamId,
        });
        if (!isCurrentGatewayStream(session, streamId, stream)) return;
        if (stream.localEnded) {
          removeGatewayStream(session, streamId, stream);
          stream.transport.outboundFlow.closeStream(streamId);
        }
      })
      .catch(() => {
        if (!isCurrentGatewayStream(session, streamId, stream)) return;
        stream.cancelled = true;
        removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
        stream.transport.outboundFlow.closeStream(streamId);
        stream.browserSocket.destroy();
        void sendReset(stream.transport, streamId, "RELAY_WRITE_FAILED");
      });
  });
}

async function sendWindowUpdate(
  transport: GatewayTransportEpoch,
  streamId: number,
  bytes: number,
): Promise<void> {
  await sendCarrierFrame(transport.socket, {
    type: FrameType.WindowUpdate,
    generation: transport.generation,
    streamId,
    payload: encodeWindowUpdate(bytes),
  });
}

function serializeRawHeaders(
  metadata: ReturnType<typeof decodeResponseHeadersMetadata>,
): Buffer {
  const statusMessage = metadata.statusMessage.replace(/[\r\n]/g, "");
  const lines = [`HTTP/1.1 ${metadata.statusCode} ${statusMessage}`];
  for (const [name, value] of isolateGatewayCredentials(
    metadata.headers,
    RESERVED_GATEWAY_COOKIES,
  )) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

function writeRawError(socket: Duplex, statusCode: number, code: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: code });
  socket.end(
    `HTTP/1.1 ${statusCode} Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n${body}`,
  );
}

function handleCanaryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hmacKey: Uint8Array,
  tokenDigest: Buffer | undefined,
): void {
  const bearer = readBearerToken(request.headers.authorization);
  if (
    tokenDigest === undefined ||
    bearer === undefined ||
    !operationalTokenMatches(hmacKey, bearer, tokenDigest)
  ) {
    writeGatewayError(response, 401, "AUTHENTICATION_REQUIRED");
    return;
  }
  const path = new URL(request.url ?? "/", "http://canary.invalid").pathname;
  const marker = "review-tunnel-canary-v1";
  if (request.method === "GET" && path === "/") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    });
    response.end(`${marker}\n`);
    return;
  }
  if (request.method === "GET" && path === "/stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    response.write(`data: ${marker}-first\n\n`);
    setTimeout(() => {
      if (!response.destroyed) response.end(`data: ${marker}-second\n\n`);
    }, 500).unref();
    return;
  }
  if (request.method === "POST" && path === "/request-stream") {
    let responseStarted = false;
    let receivedBytes = 0;
    const startResponse = () => {
      if (responseStarted || response.destroyed) return;
      responseStarted = true;
      response.writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      });
      response.write(`${marker}-request-first\n`);
    };
    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > 64 * 1024) {
        response.destroy();
        request.destroy();
        return;
      }
      startResponse();
    });
    request.once("end", () => {
      startResponse();
      if (!response.destroyed) response.end(`${marker}-request-end\n`);
    });
    request.once("error", () => response.destroy());
    return;
  }
  writeGatewayError(response, 404, "NOT_FOUND");
}

function toSafeErrorReason(value: unknown): string {
  const message = value instanceof Error ? value.message : "unknown carrier failure";
  return message.replace(/[\r\n]/g, " ").slice(0, 160);
}

async function sendReset(
  transport: GatewayTransportEpoch,
  streamId: number,
  code: string,
): Promise<void> {
  if (transport.socket.readyState !== WebSocket.OPEN) return;
  try {
    await sendCarrierFrame(transport.socket, {
      type: FrameType.ResetStream,
      generation: transport.generation,
      streamId,
      payload: encodeMetadata({ code }),
    });
  } catch {
    transport.socket.close(1011, "stream reset failed");
  }
}

async function sendSessionConfig(
  session: GatewaySession,
  transport: GatewayTransportEpoch,
): Promise<void> {
  if (!isCurrentGatewayTransport(session, transport)) return;
  const config = session.config;
  session.configSendCount += 1;
  await sendCarrierFrame(transport.socket, {
    type: FrameType.SessionConfig,
    generation: transport.generation,
    streamId: 0,
    payload: encodeMetadata(config),
  });
}

function disposeActivationCandidate(session: GatewaySession): void {
  if (session.configAckTimer !== undefined) {
    clearTimeout(session.configAckTimer);
    delete session.configAckTimer;
  }
  delete session.probe;
  session.configSendCount = 0;
  session.outboundFlow.close();
}

function armActivationTimeout(
  session: GatewaySession,
  transport: GatewayTransportEpoch,
  activationTimeoutMs: number,
): void {
  if (!Number.isInteger(activationTimeoutMs) || activationTimeoutMs < 200) {
    throw new RangeError("activationTimeoutMs must be an integer of at least 200ms");
  }
  const retryDelay = Math.floor(activationTimeoutMs / 2);
  session.configAckTimer = setTimeout(() => {
    if (
      session.lifecycle.status === "ACTIVE" ||
      !isCurrentGatewayTransport(session, transport) ||
      transport.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (session.probe === undefined && session.configSendCount === 1) {
      void sendSessionConfig(session, transport).catch(() => {
        transport.socket.close(1011, "config resend failed");
      });
    }
    session.configAckTimer = setTimeout(() => {
      if (
        session.lifecycle.status === "ACTIVE" ||
        !isCurrentGatewayTransport(session, transport) ||
        transport.socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      void rejectCarrier(
        transport.socket,
        transport.generation,
        session.probe === undefined ? "CONFIG_ACK_TIMEOUT" : "ACTIVATION_TIMEOUT",
      );
    }, activationTimeoutMs - retryDelay);
    session.configAckTimer.unref();
  }, retryDelay);
  session.configAckTimer.unref();
}

async function rejectCarrier(
  socket: WebSocket,
  generation: number,
  code: ConnectionErrorCode,
  retryAfterMs?: number,
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    await sendCarrierFrame(socket, {
      type: FrameType.ConnectionError,
      generation,
      streamId: 0,
      payload: encodeMetadata({
        code,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }),
    }).catch(() => undefined);
  }
  socket.close(1008, code);
}

function shareUrlFor(
  server: Server,
  tunnelId: string,
  contentDomain: string,
  secure: boolean,
  configuredPublicOrigin?: PublicContentOrigin,
): string {
  const publicOrigin = configuredPublicOrigin ?? listenerPublicOrigin(
    server,
    contentDomain,
    secure,
  );
  return buildTunnelShareUrl(tunnelId, publicOrigin);
}

function getTunnelId(
  host: string | undefined,
  contentDomain: string,
): string | undefined {
  const hostname = hostnameOf(host);
  if (hostname === "") return undefined;
  const suffix = `.${contentDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const tunnelId = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tunnelId)
    ? tunnelId
    : undefined;
}

function listenerPublicOrigin(
  server: Server,
  contentDomain: string,
  secure: boolean,
): PublicContentOrigin {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Gateway must be listening before a Session is provisioned");
  }
  const protocol = secure ? "https" : "http";
  const defaultPort = secure ? 443 : 80;
  const port = address.port === defaultPort ? "" : `:${address.port}`;
  return {
    protocol: `${protocol}:`,
    hostname: contentDomain,
    port: port.replace(/^:/, ""),
    origin: `${protocol}://${contentDomain}${port}`,
  };
}

function hostnameOf(host: string | undefined): string {
  if (host === undefined) return "";
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice(7);
  return token.length >= 20 && token.length <= 512 ? token : undefined;
}

function writeGatewayError(
  response: ServerResponse,
  statusCode: number,
  code: string,
): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify({ error: code });
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeHealth(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(statusCode === 200 ? "ok\n" : "unavailable\n");
}

function asBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function rawDataByteLength(data: RawData): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function digestResumeSecret(key: Uint8Array, secret: string): Buffer {
  return createHmac("sha256", key)
    .update("review-tunnel.poc.resume\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function tunnelReference(key: Uint8Array, tunnelId: string): string {
  return createHmac("sha256", key)
    .update("review-tunnel.v1.log-reference\0", "utf8")
    .update(tunnelId, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function digestOperationalToken(key: Uint8Array, token: string): Buffer {
  return createHmac("sha256", key)
    .update("review-tunnel.v1.metrics-token\0", "utf8")
    .update(token, "utf8")
    .digest();
}

function operationalTokenMatches(
  key: Uint8Array,
  token: string,
  expectedDigest: Buffer,
): boolean {
  const actual = digestOperationalToken(key, token);
  return actual.byteLength === expectedDigest.byteLength && timingSafeEqual(actual, expectedDigest);
}

function offersOnlyCarrierProfile(
  header: string | readonly string[] | undefined,
): boolean {
  const values = (Array.isArray(header) ? header : header === undefined ? [] : [header])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return values.length === 1 && values[0] === CARRIER_PROFILE;
}

function sameConfigApplied(
  left: ConfigAppliedMetadata,
  right: ConfigAppliedMetadata,
): boolean {
  return left.revision === right.revision &&
    left.digest === right.digest &&
    left.result === right.result &&
    left.localOriginReady === right.localOriginReady &&
    left.provisionReceipt === right.provisionReceipt;
}

function createFixedWindowRateLimiter(input: Readonly<{
  now: () => number;
  globalLimit: number;
  perKeyLimit: number;
}>): Readonly<{ admit(key: string): boolean }> {
  let windowStartedAt = input.now();
  let globalCount = 0;
  const keyCounts = new Map<string, number>();
  return {
    admit(key) {
      const checkedAt = input.now();
      if (checkedAt - windowStartedAt >= 60_000) {
        windowStartedAt = checkedAt;
        globalCount = 0;
        keyCounts.clear();
      }
      const keyCount = keyCounts.get(key) ?? 0;
      if (globalCount >= input.globalLimit || keyCount >= input.perKeyLimit) {
        return false;
      }
      globalCount += 1;
      keyCounts.set(key, keyCount + 1);
      return true;
    },
  };
}

function writeMetrics(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function resumeSecretMatches(
  key: Uint8Array,
  secret: string,
  expectedDigest: Buffer,
): boolean {
  const actualDigest = digestResumeSecret(key, secret);
  return (
    actualDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(actualDigest, expectedDigest)
  );
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error == null ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

async function withPromiseDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PromiseDeadlineError(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
