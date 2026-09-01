import { startGatewayOperations } from "./gateway-operations.ts";
import { createGatewayAdmission, createFixedWindowRateLimiter } from "./gateway-admission.ts";
import { attachGatewayCarrier } from "./gateway-carrier.ts";
import { createGatewaySessions } from "./gateway-session-lifecycle.ts";
import { startAuthorizationRevalidation } from "./authorization-revalidation.ts";
import type { GatewaySession } from "./gateway-session.ts";
import { handleReviewerRequest, handleReviewerUpgrade } from "./gateway-streams.ts";
import {
  writeRawError,
  writeGatewayError,
  writeHealth,
  writeMetrics,
} from "./gateway-responses.ts";
import { CONNECTION_ABORTED, settleWhileConnected, withPromiseDeadline } from "./gateway-async.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import {
  AuthError,
  type AccountAuthorization,
  type AuthService,
  type DeveloperAuthorization,
  type Principal,
} from "../../../packages/auth/src/index.ts";

import {
  CARRIER_PROFILE,
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  DEFAULT_SESSION_POLICY,
  DEFAULT_SESSION_LIMITS,
  MAX_ENVELOPE_PAYLOAD_BYTES,
  type SessionPolicy,
  type SessionLimits,
} from "../../../packages/protocol/src/index.ts";
import type { ReviewService } from "../../../packages/review/src/index.ts";
import { createWebAuthHandler, WebAuthBoundaryError } from "./web-auth.ts";
import { GatewayMetrics } from "./metrics.ts";
import {
  buildTunnelShareUrl,
  parsePublicContentOrigin,
  type PublicContentOrigin,
} from "./public-content-origin.ts";
import { attachCanaryWebSocketEcho, CANARY_ECHO_MAX_PENDING_BYTES } from "./canary-echo.ts";
import { retainAdmissionUntilSettled } from "./retained-operation.ts";
import {
  createReviewHttpHandler,
  type ReviewEventStreamPolicy,
  type ReviewTunnelTarget,
} from "./review-http.ts";

const CARRIER_PATH = "/_review-tunnel/carrier";
const CARRIER_ENVELOPE_HEADER_BYTES = 16;
const CARRIER_MAX_MESSAGE_BYTES = CARRIER_ENVELOPE_HEADER_BYTES + MAX_ENVELOPE_PAYLOAD_BYTES;
const DEFAULT_MAX_PENDING_TUNNELS = 64;
const DEFAULT_MAX_ACTIVE_TUNNELS = 1_024;
const DEFAULT_MAX_TUNNELS_PER_ACCOUNT = 8;
const DEFAULT_LOGIN_INTENTS_PER_SOURCE_PER_MINUTE = 20;
const DEFAULT_LOGIN_INTENTS_GLOBAL_PER_MINUTE = 1_000;
const DEFAULT_MAX_CANARY_WEBSOCKETS = 4;
const DEFAULT_CANARY_WEBSOCKET_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_CARRIER_FRAMES = 128;
const DEFAULT_MAX_PENDING_CARRIER_BYTES = 4 * CARRIER_MAX_MESSAGE_BYTES;

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
  reviewService?: ReviewService;
  reviewEventStreamPolicy?: ReviewEventStreamPolicy;
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

export function createGatewayServer(options: GatewayServerOptions = {}): GatewayServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const contentDomain = options.contentDomain ?? "localhost";
  const configuredPublicContentOrigin =
    options.publicContentOrigin === undefined
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
  const canaryWebSocketIdleTimeoutMs =
    options.canaryWebSocketIdleTimeoutMs ?? DEFAULT_CANARY_WEBSOCKET_IDLE_TIMEOUT_MS;
  const maxPendingCarrierFrames =
    options.maxPendingCarrierFrames ?? DEFAULT_MAX_PENDING_CARRIER_FRAMES;
  const maxPendingCarrierBytes =
    options.maxPendingCarrierBytes ?? DEFAULT_MAX_PENDING_CARRIER_BYTES;
  if (!Number.isSafeInteger(maxCanaryWebSockets) || maxCanaryWebSockets <= 0) {
    throw new RangeError("maxCanaryWebSockets must be a positive safe integer");
  }
  if (!Number.isSafeInteger(authorizationQueryTimeoutMs) || authorizationQueryTimeoutMs <= 0) {
    throw new RangeError("authorizationQueryTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(canaryWebSocketIdleTimeoutMs) || canaryWebSocketIdleTimeoutMs <= 0) {
    throw new RangeError("canaryWebSocketIdleTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPendingCarrierFrames) || maxPendingCarrierFrames <= 0) {
    throw new RangeError("maxPendingCarrierFrames must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(maxPendingCarrierBytes) ||
    maxPendingCarrierBytes < CARRIER_MAX_MESSAGE_BYTES
  ) {
    throw new RangeError(`maxPendingCarrierBytes must be at least ${CARRIER_MAX_MESSAGE_BYTES}`);
  }
  if (options.reviewService !== undefined && options.authService === undefined) {
    throw new Error("review service requires authenticated Gateway mode");
  }
  const resolveReviewTunnel = (tunnelId: string): ReviewTunnelTarget | undefined => {
    const session = sessions.get(tunnelId);
    if (
      session?.ownerAccountId === undefined ||
      (session.lifecycle.status !== "ACTIVE" && session.lifecycle.status !== "RECONNECTING")
    )
      return undefined;
    return {
      tunnelId: session.tunnelId,
      sessionId: session.sessionId,
      ownerAccountId: session.ownerAccountId,
      publicOrigin: new URL(session.shareUrl).origin,
      active: session.lifecycle.status === "ACTIVE" && session.socket.readyState === WebSocket.OPEN,
      expiresAt: new Date(session.lifecycle.activatedAt + session.policy.maxTtlMs),
    };
  };
  const reviewHttp =
    options.reviewService === undefined
      ? undefined
      : createReviewHttpHandler({
          service: options.reviewService,
          resolveTunnel: resolveReviewTunnel,
          ...(options.reviewEventStreamPolicy === undefined
            ? {}
            : { eventStreamPolicy: options.reviewEventStreamPolicy }),
          reportFailure(operation) {
            options.logger?.({
              timestamp: new Date(now()).toISOString(),
              event: `review.${operation}_failed`,
              reason: "unavailable",
            });
          },
        });
  const admission = createGatewayAdmission({
    getSessions: () => sessions,
    now,
    maxPendingTunnels,
    maxActiveTunnels,
    maxTunnelsPerAccount,
    config: options,
  });
  const {
    canAdmitNewTunnel,
    canActivateTunnel,
    consumeCredentialReservation,
    reservePendingCarrierConnection,
    reserveCarrierAuthorizationAttempt,
  } = admission;
  const pendingCarrierReleases = new WeakMap<WebSocket, () => void>();
  const loginIntentLimiter = createFixedWindowRateLimiter({
    now,
    perKeyLimit:
      options.loginIntentsPerSourcePerMinute ?? DEFAULT_LOGIN_INTENTS_PER_SOURCE_PER_MINUTE,
    globalLimit: options.loginIntentsGlobalPerMinute ?? DEFAULT_LOGIN_INTENTS_GLOBAL_PER_MINUTE,
  });
  const sessionLimits: SessionLimits = {
    ...DEFAULT_SESSION_LIMITS,
    ...options.sessionLimits,
    maxStreamDurationMs: Math.min(
      options.sessionLimits?.maxStreamDurationMs ?? DEFAULT_SESSION_LIMITS.maxStreamDurationMs,
      sessionPolicy.maxTtlMs,
    ),
  };
  const webAuth =
    options.authService === undefined
      ? undefined
      : createWebAuthHandler({
          authService: options.authService,
          controlHost: options.controlHost ?? `control.${contentDomain}`,
          secureCookies: options.secureCookies ?? true,
          authorizationQueryTimeoutMs,
          async setKillSwitch(enabled, actor) {
            await options.persistKillSwitch?.(enabled, actor);
            operations.setKillSwitch(enabled);
          },
          getKillSwitch() {
            return operations.isKillSwitchEnabled();
          },
          ...(reviewHttp === undefined
            ? {}
            : { clientControlExtension: reviewHttp.clientControlExtension }),
          reserveCarrierCredential: admission.reserveCarrierCredential,
          admitLoginIntent(remoteAddress, _targetHost) {
            return loginIntentLimiter.admit(remoteAddress);
          },
          ...(options.maxConcurrentLoginAttempts === undefined
            ? {}
            : { maxConcurrentLoginAttempts: options.maxConcurrentLoginAttempts }),
          ...(options.maxConcurrentLoginAttemptsPerRemote === undefined
            ? {}
            : {
                maxConcurrentLoginAttemptsPerRemote: options.maxConcurrentLoginAttemptsPerRemote,
              }),
          ...(options.loginAttemptsPerMinute === undefined
            ? {}
            : { loginAttemptsPerMinute: options.loginAttemptsPerMinute }),
          ...(options.loginAttemptsPerRemotePerMinute === undefined
            ? {}
            : {
                loginAttemptsPerRemotePerMinute: options.loginAttemptsPerRemotePerMinute,
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
  const metricsTokenDigest =
    options.metricsBearerToken === undefined
      ? undefined
      : digestOperationalToken(resumeHmacKey, options.metricsBearerToken);
  const canaryTokenDigest =
    options.canaryBearerToken === undefined
      ? undefined
      : digestOperationalToken(resumeHmacKey, options.canaryBearerToken);
  const canaryHostname =
    options.canaryHost === undefined ? undefined : hostnameOf(options.canaryHost);
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
  const sessionOwner = createGatewaySessions({
    metrics,
    emit,
    ...(reviewHttp === undefined
      ? {}
      : {
          onDisposed: (session: GatewaySession) =>
            reviewHttp.disposeBinding({ tunnelId: session.tunnelId, sessionId: session.sessionId }),
        }),
  });
  const { sessions, expireGatewaySession, terminateGatewaySession, disposeGatewaySession } =
    sessionOwner;
  const operations = startGatewayOperations({
    sessions,
    metrics,
    emit,
    authService: options.authService,
    now,
    gatewayAdmissionReady,
    initialKillSwitch: options.initialKillSwitch ?? false,
    authCleanupTimeoutMs,
    heartbeatIntervalMs,
    carrierLeaseMs,
    authorizationMaxAgeMs,
    sessionTickIntervalMs,
    sessionPolicy,
    expireGatewaySession,
    terminateGatewaySession,
  });
  let healthCheckInFlight: Promise<void> | undefined;
  const sharedHealthCheck = (): Promise<void> => {
    if (options.authService === undefined && options.reviewService === undefined) {
      return Promise.resolve();
    }
    if (healthCheckInFlight !== undefined) return healthCheckInFlight;
    let running: Promise<void>;
    try {
      running = Promise.all([
        options.authService?.checkHealth(),
        options.reviewService?.checkHealth(),
      ]).then(() => undefined);
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
        if (canaryHostname !== undefined && hostnameOf(request.headers.host) === canaryHostname) {
          handleCanaryRequest(request, response, resumeHmacKey, canaryTokenDigest);
          return;
        }
        if (
          hostnameOf(request.headers.host) === controlHostname &&
          requestPath === "/health/live"
        ) {
          writeHealth(response, 200);
          return;
        }
        if (
          hostnameOf(request.headers.host) === controlHostname &&
          requestPath === "/health/ready"
        ) {
          try {
            if (options.authService !== undefined || options.reviewService !== undefined) {
              await withPromiseDeadline(
                sharedHealthCheck(),
                authorizationQueryTimeoutMs,
                "Gateway dependency health query timed out",
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
          writeMetrics(response, metrics.render(operations.metricSnapshot()));
          return;
        }
        if (webAuth !== undefined && hostnameOf(request.headers.host) === controlHostname) {
          await webAuth.handleControl(request, response);
          return;
        }
        if (operations.isKillSwitchEnabled()) {
          writeGatewayError(response, 503, "SERVICE_DISABLED");
          return;
        }
        const tunnelId = getTunnelId(request.headers.host, contentDomain);
        if (webAuth !== undefined && tunnelId === undefined) {
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
        if (reviewHttp?.matchesContentPath(requestPath) === true) {
          const tunnel = tunnelId === undefined ? undefined : resolveReviewTunnel(tunnelId);
          if (tunnel === undefined || reviewer === undefined) {
            writeGatewayError(response, 404, "NOT_FOUND");
            return;
          }
          await reviewHttp.handleContent({
            request,
            response,
            principal: reviewer,
            tunnel,
          });
          return;
        }
        if (requestPath.startsWith("/_review-tunnel/")) {
          writeGatewayError(response, 404, "NOT_FOUND");
          return;
        }
        await handleReviewerRequest(sessions, tunnelId, request, response, reviewer);
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
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://gateway.invalid");
    } catch {
      writeRawError(socket, 400, "INVALID_REQUEST_TARGET");
      return;
    }
    if (canaryHostname !== undefined && hostnameOf(request.headers.host) === canaryHostname) {
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
    if (operations.isKillSwitchEnabled()) {
      writeRawError(socket, 503, "SERVICE_DISABLED");
      return;
    }
    if (url.pathname !== CARRIER_PATH) {
      if (request.headers.upgrade?.toLowerCase() !== "websocket") {
        writeRawError(socket, 501, "UNSUPPORTED_UPGRADE");
        return;
      }
      const tunnelId = getTunnelId(request.headers.host, contentDomain);
      if (webAuth !== undefined && tunnelId === undefined) {
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
        await handleReviewerUpgrade(sessions, tunnelId, request, socket, head, reviewer);
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
    const releaseCarrierAuthorization =
      options.authService === undefined ? undefined : reserveCarrierAuthorizationAttempt();
    let releasePendingCarrier =
      options.authService === undefined ? reservePendingCarrierConnection() : undefined;
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
            error instanceof AuthError ? "AUTHENTICATION_FAILED" : "AUTHENTICATION_UNAVAILABLE",
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
    })()
      .catch(() => {
        releasePendingCarrier?.();
        writeRawError(socket, 500, "INTERNAL_ERROR");
      })
      .finally(() => releaseCarrierAuthorization?.());
  });
  server.on("connect", (_request, socket) => {
    writeRawError(socket, 501, "CONNECT_NOT_SUPPORTED");
  });

  carriers.on("connection", (socket) =>
    attachGatewayCarrier(socket, {
      sessionOwner,
      developerAuthorization: carrierAuthorizations.get(socket),
      releasePendingCarrier: pendingCarrierReleases.get(socket) ?? (() => undefined),
      config: {
        requireAuthorization: options.authService !== undefined,
        sessionPolicy,
        sessionLimits,
        activationTimeoutMs,
        maxPendingCarrierFrames,
        maxPendingCarrierBytes,
      },
      admission: {
        canAdmitNewTunnel,
        canActivateTunnel,
        isReady: () => !operations.isKillSwitchEnabled() && gatewayAdmissionReady(),
      },
      metrics,
      emit,
      now,
      resumeHmacKey,
      shareUrlForTunnel: (tunnelId) =>
        shareUrlFor(
          server,
          tunnelId,
          contentDomain,
          options.secureCookies ?? options.authService !== undefined,
          configuredPublicContentOrigin,
        ),
    }),
  );

  const stopAuthorizationRevalidation = startAuthorizationRevalidation({
    authService: options.authService,
    sessions,
    authorizationQueryTimeoutMs,
    intervalMs: options.authorizationCheckIntervalMs ?? 5_000,
    emit,
    terminateGatewaySession,
  });

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
      stopAuthorizationRevalidation();
      operations.close();
      for (const session of sessions.values()) {
        disposeGatewaySession(session, "TUNNEL_OFFLINE");
      }
      reviewHttp?.close();
      admission.close();
      for (const socket of carriers.clients) socket.terminate();
      for (const socket of canaryWebSockets.clients) socket.terminate();
      for (const socket of serverSockets) socket.destroy();
      await closeHttpServer(server);
      await new Promise<void>((resolve) => carriers.close(() => resolve()));
      await new Promise<void>((resolve) => canaryWebSockets.close(() => resolve()));
      await sessionOwner.waitForCleanup();
    },
    setKillSwitch(enabled) {
      operations.setKillSwitch(enabled);
    },
    isKillSwitchEnabled() {
      return operations.isKillSwitchEnabled();
    },
    metrics() {
      return metrics.render(operations.metricSnapshot());
    },
  };
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

function shareUrlFor(
  server: Server,
  tunnelId: string,
  contentDomain: string,
  secure: boolean,
  configuredPublicOrigin?: PublicContentOrigin,
): string {
  const publicOrigin =
    configuredPublicOrigin ?? listenerPublicOrigin(server, contentDomain, secure);
  return buildTunnelShareUrl(tunnelId, publicOrigin);
}

function getTunnelId(host: string | undefined, contentDomain: string): string | undefined {
  const hostname = hostnameOf(host);
  if (hostname === "") return undefined;
  const suffix = `.${contentDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const tunnelId = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tunnelId) ? tunnelId : undefined;
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

function operationalTokenMatches(key: Uint8Array, token: string, expectedDigest: Buffer): boolean {
  const actual = digestOperationalToken(key, token);
  return actual.byteLength === expectedDigest.byteLength && timingSafeEqual(actual, expectedDigest);
}

function offersOnlyCarrierProfile(header: string | readonly string[] | undefined): boolean {
  const values = (Array.isArray(header) ? header : header === undefined ? [] : [header])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return values.length === 1 && values[0] === CARRIER_PROFILE;
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error == null ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
