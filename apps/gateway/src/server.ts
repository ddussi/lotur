import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type {
  AuthService,
  DeveloperAuthorization,
  Principal,
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
  isResumeAllowed,
  type ConnectionErrorCode,
  type SessionConfigMetadata,
  type SessionPolicy,
  type SessionLimits,
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
import { createWebAuthHandler } from "./web-auth.ts";
import { GatewayMetrics } from "./metrics.ts";

const CARRIER_PATH = "/_review-tunnel/carrier";
const CONFIG_ACK_RETRY_MS = DEFAULT_ACTIVATION_TIMEOUT_MS / 2;
const RESERVED_GATEWAY_COOKIES = new Set([
  "__Host-rt_control",
  "__Host-rt_session",
  "rt_control_dev",
  "rt_session_dev",
]);

type GatewayHttpStream = {
  readonly kind: "HTTP";
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  requestEnded: boolean;
  responseEnded: boolean;
  responseBytes: number;
  finiteResponse: boolean;
  requestInactivityTimer?: NodeJS.Timeout;
  durationTimer?: NodeJS.Timeout;
  cancelled: boolean;
  readonly reviewerAccountId?: string;
  readonly reviewerAuthVersion?: number;
  readonly reviewerAuthorizedAt?: number;
};

type GatewayWebSocketStream = {
  readonly kind: "WEBSOCKET";
  readonly browserSocket: Duplex;
  readonly pendingHead: Uint8Array;
  responseStarted: boolean;
  upgraded: boolean;
  browserEnded: boolean;
  localEnded: boolean;
  cancelled: boolean;
  readonly reviewerAccountId?: string;
  readonly reviewerAuthVersion?: number;
  readonly reviewerAuthorizedAt?: number;
  durationTimer?: NodeJS.Timeout;
};

type GatewayStream = GatewayHttpStream | GatewayWebSocketStream;

type GatewaySession = {
  readonly sessionId: string;
  readonly tunnelId: string;
  readonly shareUrl: string;
  socket: WebSocket;
  readonly streams: Map<number, GatewayStream>;
  outboundFlow: OutboundFlowWindow;
  generation: number;
  revision: number;
  config: SessionConfigMetadata;
  active: boolean;
  everActive: boolean;
  activatedAt?: number;
  lastStreamClosedAt?: number;
  lastPongAt: number;
  developerAuthorizedAt: number;
  readonly now: () => number;
  readonly metrics: GatewayMetrics;
  streamRateWindowStartedAt: number;
  streamsOpenedInWindow: number;
  provisionId?: string;
  resumeSecret?: string;
  configAckTimer?: NodeJS.Timeout;
  configSendCount: number;
  probe?: {
    readonly streamId: number;
    readonly expected: Buffer;
    readonly received: Buffer[];
    receivedBytes: number;
    clientEnded: boolean;
  };
  readonly resumeDigest: Buffer;
  disconnectedAt?: number;
  expiryTimer?: NodeJS.Timeout;
  terminal: boolean;
  nextStreamId: number;
  readonly ownerAccountId?: string;
  readonly ownerAuthVersion?: number;
};

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
  logger?: (event: GatewayLogEvent) => void;
  metricsBearerToken?: string;
}>;

export function createGatewayServer(
  options: GatewayServerOptions = {},
): GatewayServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const contentDomain = options.contentDomain ?? "localhost";
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const gatewayAdmissionReady = options.gatewayAdmissionReady ?? (() => true);
  const sessionPolicy = options.sessionPolicy ?? DEFAULT_SESSION_POLICY;
  const sessionTickIntervalMs = options.sessionTickIntervalMs ?? 1_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const carrierLeaseMs = options.carrierLeaseMs ?? 45_000;
  const authorizationMaxAgeMs = options.authorizationMaxAgeMs ?? 12 * 60 * 60_000;
  const now = options.now ?? Date.now;
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
    setKillSwitch(enabled) {
      updateKillSwitch(enabled);
    },
    getKillSwitch() {
      return killSwitchEnabled;
    },
  });
  const controlHostname = hostnameOf(options.controlHost ?? `control.${contentDomain}`);
  const resumeHmacKey = randomBytes(32);
  const metricsTokenDigest = options.metricsBearerToken === undefined
    ? undefined
    : digestOperationalToken(resumeHmacKey, options.metricsBearerToken);
  const metrics = new GatewayMetrics();
  const sessions = new Map<string, GatewaySession>();
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
  const server = createServer((request, response) => {
    void (async () => {
      try {
        let reviewer: Principal | undefined;
        const requestPath = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
        if (hostnameOf(request.headers.host) === controlHostname && requestPath === "/health/live") {
          writeHealth(response, 200);
          return;
        }
        if (hostnameOf(request.headers.host) === controlHostname && requestPath === "/health/ready") {
          try {
            await options.authService?.checkHealth();
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
        if (webAuth !== undefined) {
          reviewer = await webAuth.authorizeContent(request, response);
          if (reviewer === undefined) return;
        }
        if (requestPath.startsWith("/_review-tunnel/")) {
          writeGatewayError(response, 404, "NOT_FOUND");
          return;
        }
        await handleReviewerRequest(
          sessions,
          contentDomain,
          request,
          response,
          reviewer,
        );
      } catch {
        writeGatewayError(response, 500, "INTERNAL_ERROR");
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
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(CARRIER_PROFILE) ? CARRIER_PROFILE : false;
    },
  });
  const carrierAuthorizations = new WeakMap<WebSocket, DeveloperAuthorization>();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    if (killSwitchEnabled) {
      writeRawError(socket, 503, "SERVICE_DISABLED");
      return;
    }
    if (url.pathname !== CARRIER_PATH) {
      if (request.headers.upgrade?.toLowerCase() !== "websocket") {
        writeRawError(socket, 501, "UNSUPPORTED_UPGRADE");
        return;
      }
      void (async () => {
        let reviewer: Principal | undefined;
        if (webAuth !== undefined) {
          reviewer = await webAuth.resolveContentUpgrade(request);
          if (hostnameOf(request.headers.host) === controlHostname || reviewer === undefined) {
            writeRawError(socket, 401, "AUTHENTICATION_REQUIRED");
            return;
          }
        }
        await handleReviewerUpgrade(
          sessions,
          contentDomain,
          request,
          socket,
          head,
          reviewer,
        );
      })().catch(() => writeRawError(socket, 500, "INTERNAL_ERROR"));
      return;
    }
    if (head.byteLength !== 0) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
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
        } catch {
          writeRawError(socket, 401, "AUTHENTICATION_FAILED");
          return;
        }
      }
      carriers.handleUpgrade(request, socket, head, (webSocket) => {
        if (authorization !== undefined) carrierAuthorizations.set(webSocket, authorization);
        carriers.emit("connection", webSocket, request);
      });
    })().catch(() => writeRawError(socket, 500, "INTERNAL_ERROR"));
  });
  server.on("connect", (_request, socket) => {
    writeRawError(socket, 501, "CONNECT_NOT_SUPPORTED");
  });

  carriers.on("connection", (socket) => {
    const developerAuthorization = carrierAuthorizations.get(socket);
    let session: GatewaySession | undefined;
    let connectionMode: "create" | "resume" | undefined;
    let receiveQueue = Promise.resolve();
    const helloTimer = setTimeout(() => {
      if (session === undefined) socket.close(1008, "HELLO timeout");
    }, 5_000);
    helloTimer.unref();

    socket.on("message", (data, isBinary) => {
      receiveQueue = receiveQueue
        .then(async () => {
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
            if (hello.mode === "create") {
              if (sessions.has(hello.tunnelId)) {
                await rejectCarrier(socket, 0, "PROTOCOL_ERROR");
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
                outboundFlow: new OutboundFlowWindow(
                  INITIAL_CONNECTION_WINDOW_BYTES,
                ),
                generation,
                revision: 1,
                config: {
                  revision: 1,
                  digest: digestSessionConfig(snapshot),
                  snapshot,
                },
                active: false,
                everActive: false,
                lastPongAt: now(),
                developerAuthorizedAt: now(),
                now,
                metrics,
                streamRateWindowStartedAt: now(),
                streamsOpenedInWindow: 0,
                provisionId,
                resumeSecret,
                configSendCount: 0,
                resumeDigest: digestResumeSecret(resumeHmacKey, resumeSecret),
                terminal: false,
                nextStreamId: 1,
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
                existing.disconnectedAt === undefined ||
                !isResumeAllowed(now(), existing.disconnectedAt, sessionPolicy) ||
                !resumeSecretMatches(
                  resumeHmacKey,
                  hello.resumeSecret,
                  existing.resumeDigest,
                )
              ) {
                await rejectCarrier(socket, 0, "RESUME_REJECTED");
                return;
              }
              if (existing.socket.readyState === WebSocket.OPEN) {
                await rejectCarrier(socket, 0, "RESUME_IN_PROGRESS", 500);
                return;
              }
              if (
                developerAuthorization !== undefined &&
                existing.ownerAccountId !== developerAuthorization.accountId
              ) {
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
              existing.socket = socket;
              existing.outboundFlow = new OutboundFlowWindow(
                INITIAL_CONNECTION_WINDOW_BYTES,
              );
              existing.generation += 1;
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
              existing.active = false;
              existing.lastPongAt = now();
              existing.developerAuthorizedAt = now();
              existing.configSendCount = 0;
              existing.nextStreamId = 1;
              session = existing;
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
            }
            await sendSessionConfig(session);
            armActivationTimeout(
              session,
              socket,
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
          if (!session.active) {
            if (envelope.type === FrameType.ConfigApplied) {
              const applied = decodeConfigAppliedMetadata(envelope.payload);
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
              delete session.provisionId;
              delete session.resumeSecret;
              if (session.probe === undefined) {
                metrics.increment("config_applied");
                emit("tunnel.config_applied", session);
                const streamId = session.nextStreamId;
                session.nextStreamId += 2;
                const nonce = randomBytes(32);
                session.probe = {
                  streamId,
                  expected: nonce,
                  received: [],
                  receivedBytes: 0,
                  clientEnded: false,
                };
                session.outboundFlow.openStream(
                  streamId,
                  INITIAL_STREAM_WINDOW_BYTES,
                );
                await sendCarrierFrame(socket, {
                  type: FrameType.OpenProbe,
                  generation: session.generation,
                  streamId,
                  payload: encodeMetadata({
                    initialWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
                  }),
                });
                await sendFlowControlledData(socket, session.outboundFlow, {
                  generation: session.generation,
                  streamId,
                  chunk: nonce,
                });
                await sendCarrierFrame(socket, {
                  type: FrameType.EndStream,
                  generation: session.generation,
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
              probe.receivedBytes += envelope.payload.byteLength;
              if (probe.receivedBytes > probe.expected.byteLength) {
                throw new Error("Relay probe payload is too large");
              }
              probe.received.push(Buffer.from(envelope.payload));
              await sendWindowUpdate(session, probe.streamId, envelope.payload.byteLength);
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
              session.outboundFlow.closeStream(probe.streamId);
              delete session.probe;
              await sendCarrierFrame(socket, {
                type: FrameType.SessionActive,
                generation: session.generation,
                streamId: 0,
                payload: encodeMetadata({
                  generation: session.generation,
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
              if (session.configAckTimer !== undefined) {
                clearTimeout(session.configAckTimer);
                delete session.configAckTimer;
              }
              if (session.expiryTimer !== undefined) {
                clearTimeout(session.expiryTimer);
                delete session.expiryTimer;
              }
              delete session.disconnectedAt;
              const resumed = session.everActive;
              session.active = true;
              session.everActive = true;
              session.activatedAt ??= now();
              session.lastStreamClosedAt ??= now();
              metrics.increment(resumed ? "tunnel_resumed" : "tunnel_active");
              emit(resumed ? "tunnel.resumed" : "tunnel.active", session);
              return;
            }
            throw new Error("unexpected activation frame");
          }
          if (envelope.type === FrameType.CloseSession && envelope.streamId === 0) {
            session.terminal = true;
            socket.close(1000, "session closed");
            return;
          }
          await handleClientFrame(session, envelope);
        })
        .catch((error: unknown) => {
          emit("carrier.protocol_error", session, { reason: toSafeErrorReason(error) });
          socket.close(1002, "protocol error");
        });
    });

    const cleanup = () => {
      clearTimeout(helloTimer);
      if (
        session === undefined ||
        sessions.get(session.tunnelId) !== session ||
        session.socket !== socket
      ) return;
      const current = session;
      const wasActive = current.active;
      if (current.configAckTimer !== undefined) {
        clearTimeout(current.configAckTimer);
        delete current.configAckTimer;
      }
      current.active = false;
      current.outboundFlow.close();
      for (const stream of current.streams.values()) {
        stream.cancelled = true;
        clearGatewayStreamTimers(stream);
        if (stream.kind === "HTTP" && !stream.response.headersSent) {
          writeGatewayError(stream.response, 503, "TUNNEL_OFFLINE");
        } else if (stream.kind === "HTTP") {
          stream.response.destroy();
        } else {
          stream.browserSocket.destroy();
        }
      }
      current.streams.clear();
      if (current.terminal || !current.everActive) {
        metrics.increment(current.terminal ? "tunnel_closed" : "activation_failed");
        emit(
          current.terminal ? "tunnel.closed" : "tunnel.activation_failed",
          current,
        );
        sessions.delete(current.tunnelId);
        return;
      }
      if (!wasActive) {
        metrics.increment("activation_failed");
        emit("tunnel.activation_failed", current);
      } else {
        metrics.increment("tunnel_reconnecting");
        emit("tunnel.reconnecting", current);
      }
      current.disconnectedAt ??= now();
      if (current.expiryTimer !== undefined) clearTimeout(current.expiryTimer);
      const reconnectDelay = Math.max(
        0,
        current.disconnectedAt + current.config.snapshot.reconnectGraceMs - now() + 10,
      );
      current.expiryTimer = setTimeout(() => {
        if (
          sessions.get(current.tunnelId) === current &&
          current.disconnectedAt !== undefined &&
          !isResumeAllowed(now(), current.disconnectedAt, sessionPolicy)
        ) {
          sessions.delete(current.tunnelId);
          metrics.increment("tunnel_expired");
          emit("tunnel.expired", current, { reason: "RECONNECT_TIMEOUT" });
        }
      }, reconnectDelay);
      current.expiryTimer.unref();
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  });

  let revocationCheckRunning = false;
  const revocationTimer = setInterval(() => {
    if (options.authService === undefined || revocationCheckRunning) return;
    revocationCheckRunning = true;
    void (async () => {
      for (const session of sessions.values()) {
        if (session.ownerAccountId !== undefined && session.ownerAuthVersion !== undefined) {
          if (!await options.authService?.isAccountAuthorized(
            session.ownerAccountId,
            session.ownerAuthVersion,
            "DEVELOPER",
          )) {
            session.terminal = true;
            session.socket.close(1008, "developer authorization revoked");
          }
        }
        for (const [streamId, stream] of session.streams) {
          if (stream.reviewerAccountId === undefined || stream.reviewerAuthVersion === undefined) continue;
          if (!await options.authService?.isAccountAuthorized(
            stream.reviewerAccountId,
            stream.reviewerAuthVersion,
            "REVIEWER",
          )) {
            stream.cancelled = true;
            removeGatewayStream(session, streamId);
            session.outboundFlow.closeStream(streamId);
            if (stream.kind === "HTTP") stream.response.destroy();
            else stream.browserSocket.destroy();
            await sendReset(session, streamId, "AUTHORIZATION_REVOKED");
          }
        }
      }
    })().finally(() => {
      revocationCheckRunning = false;
    });
  }, options.authorizationCheckIntervalMs ?? 5_000);
  revocationTimer.unref();
  const authCleanupTimer = setInterval(() => {
    void options.authService?.cleanupExpiredArtifacts().catch(() => {
      console.error(JSON.stringify({ event: "auth_cleanup_failed" }));
    });
  }, 10 * 60_000);
  authCleanupTimer.unref();

  const heartbeatTimer = setInterval(() => {
    const checkedAt = now();
    for (const session of sessions.values()) {
      if (session.socket.readyState !== WebSocket.OPEN) continue;
      if (checkedAt - session.lastPongAt >= carrierLeaseMs) {
        session.socket.close(1001, "carrier lease expired");
        continue;
      }
      void sendCarrierFrame(session.socket, {
        type: FrameType.Ping,
        generation: session.generation,
        streamId: 0,
      }).catch(() => session.socket.close(1011, "heartbeat failed"));
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  const sessionTimer = setInterval(() => {
    const checkedAt = now();
    for (const session of sessions.values()) {
      if (!session.active || session.activatedAt === undefined) continue;
      const maxExpired = checkedAt >= session.activatedAt + sessionPolicy.maxTtlMs;
      const idleExpired =
        session.streams.size === 0 &&
        session.lastStreamClosedAt !== undefined &&
        checkedAt >= session.lastStreamClosedAt + sessionPolicy.idleTimeoutMs;
      const developerAuthorizationExpired =
        checkedAt >= session.developerAuthorizedAt + authorizationMaxAgeMs;
      if (maxExpired || idleExpired || developerAuthorizationExpired) {
        metrics.increment("tunnel_expired");
        emit("tunnel.expired", session, {
          reason: developerAuthorizationExpired
            ? "AUTHORIZATION_EXPIRED"
            : maxExpired
              ? "MAX_TTL"
              : "IDLE_TIMEOUT",
        });
        session.terminal = true;
        session.socket.close(
          1008,
          developerAuthorizationExpired
            ? "developer authorization expired"
            : maxExpired
              ? "session maximum TTL expired"
              : "session idle timeout",
        );
        continue;
      }
      for (const [streamId, stream] of session.streams) {
        if (
          stream.reviewerAuthorizedAt === undefined ||
          checkedAt < stream.reviewerAuthorizedAt + authorizationMaxAgeMs
        ) {
          continue;
        }
        stream.cancelled = true;
        removeGatewayStream(session, streamId);
        session.outboundFlow.closeStream(streamId);
        if (stream.kind === "HTTP") stream.response.destroy();
        else stream.browserSocket.destroy();
        void sendReset(session, streamId, "AUTHORIZATION_EXPIRED");
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
      for (const socket of carriers.clients) socket.terminate();
      for (const socket of serverSockets) socket.destroy();
      await closeHttpServer(server);
      await new Promise<void>((resolve) => carriers.close(() => resolve()));
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
      session.active = false;
      session.terminal = true;
      for (const [streamId, stream] of session.streams) {
        stream.cancelled = true;
        removeGatewayStream(session, streamId);
        session.outboundFlow.closeStream(streamId);
        if (stream.kind === "HTTP") stream.response.destroy();
        else stream.browserSocket.destroy();
      }
      session.socket.close(1008, "operational kill switch");
    }
  }

  function metricSnapshot() {
    let activeTunnels = 0;
    let reconnectingTunnels = 0;
    let activeStreams = 0;
    for (const session of sessions.values()) {
      if (session.active) activeTunnels += 1;
      else if (session.disconnectedAt !== undefined) reconnectingTunnels += 1;
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
}

async function handleReviewerRequest(
  sessions: ReadonlyMap<string, GatewaySession>,
  contentDomain: string,
  request: IncomingMessage,
  response: ServerResponse,
  reviewer?: Principal,
): Promise<void> {
  const tunnelId = getTunnelId(request.headers.host, contentDomain);
  const session = tunnelId === undefined ? undefined : sessions.get(tunnelId);
  if (
    session === undefined ||
    !session.active ||
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

  const streamId = session.nextStreamId;
  session.nextStreamId += 2;
  const stream: GatewayHttpStream = {
    kind: "HTTP",
    request,
    response,
    requestEnded: false,
    responseEnded: false,
    responseBytes: 0,
    finiteResponse: false,
    cancelled: false,
    ...(reviewer === undefined ? {} : {
      reviewerAccountId: reviewer.accountId,
      reviewerAuthVersion: reviewer.authVersion,
      reviewerAuthorizedAt: session.now(),
    }),
  };
  session.streams.set(streamId, stream);
  session.metrics.increment("stream_opened");
  const expireStream = (code: string) => {
    if (stream.cancelled) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId);
    session.outboundFlow.closeStream(streamId);
    if (!response.headersSent) writeGatewayError(response, 408, code);
    else response.destroy();
    request.destroy();
    void sendReset(session, streamId, code);
  };
  stream.durationTimer = setTimeout(
    () => expireStream("LIMIT_EXCEEDED"),
    session.config.snapshot.maxStreamDurationMs,
  );
  stream.durationTimer.unref();
  touchRequestInactivity(stream, session.config.snapshot.streamInactivityTimeoutMs, expireStream);
  session.outboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);

  response.once("close", () => {
    if (stream.responseEnded || stream.cancelled) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId);
    session.outboundFlow.closeStream(streamId);
    void sendReset(session, streamId, "DOWNSTREAM_CANCELLED");
  });

  try {
    await sendCarrierFrame(session.socket, {
      type: FrameType.OpenHttp,
      generation: session.generation,
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
      if (stream.cancelled) return;
      touchRequestInactivity(
        stream,
        session.config.snapshot.streamInactivityTimeoutMs,
        expireStream,
      );
      requestBytes += chunk.byteLength;
      if (requestBytes > session.config.snapshot.maxRequestBodyBytes) {
        stream.cancelled = true;
        removeGatewayStream(session, streamId);
        session.outboundFlow.closeStream(streamId);
        if (!response.headersSent) writeGatewayError(response, 413, "REQUEST_TOO_LARGE");
        else response.destroy();
        await sendReset(session, streamId, "REQUEST_TOO_LARGE");
        return;
      }
      await sendFlowControlledData(session.socket, session.outboundFlow, {
        generation: session.generation,
        streamId,
        chunk,
      });
    }
    if (stream.cancelled) return;
    clearRequestInactivityTimer(stream);
    stream.requestEnded = true;
    await sendCarrierFrame(session.socket, {
      type: FrameType.EndStream,
      generation: session.generation,
      streamId,
    });
    maybeDeleteStream(session, streamId, stream);
  } catch {
    stream.cancelled = true;
    removeGatewayStream(session, streamId);
    session.outboundFlow.closeStream(streamId);
    if (!response.headersSent) writeGatewayError(response, 502, "RELAY_WRITE_FAILED");
    else response.destroy();
    await sendReset(session, streamId, "RELAY_WRITE_FAILED");
  }
}

async function handleClientFrame(
  session: GatewaySession,
  envelope: ReturnType<typeof decodeEnvelope>,
): Promise<void> {
  const stream = session.streams.get(envelope.streamId);
  if (stream === undefined || stream.cancelled) return;
  if (envelope.type === FrameType.WindowUpdate) {
    session.outboundFlow.update(
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
      stream.finiteResponse = isFiniteHttpResponse(
        stream.request.method,
        metadata.statusCode,
        metadata.headers,
        declaredResponseBytes,
      );
      if (
        stream.finiteResponse &&
        declaredResponseBytes !== undefined &&
        declaredResponseBytes > session.config.snapshot.maxFiniteResponseBytes
      ) {
        stream.cancelled = true;
        removeGatewayStream(session, envelope.streamId);
        session.outboundFlow.closeStream(envelope.streamId);
        writeGatewayError(stream.response, 502, "UPSTREAM_RESPONSE_TOO_LARGE");
        await sendReset(session, envelope.streamId, "UPSTREAM_RESPONSE_TOO_LARGE");
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
      stream.responseBytes += envelope.payload.byteLength;
      if (
        stream.finiteResponse &&
        stream.responseBytes > session.config.snapshot.maxFiniteResponseBytes
      ) {
        stream.cancelled = true;
        removeGatewayStream(session, envelope.streamId);
        session.outboundFlow.closeStream(envelope.streamId);
        stream.response.destroy();
        await sendReset(session, envelope.streamId, "UPSTREAM_RESPONSE_TOO_LARGE");
        return;
      }
      if (!stream.response.write(envelope.payload)) {
        session.socket.pause();
        await once(stream.response, "drain");
        session.socket.resume();
      }
      await sendWindowUpdate(session, envelope.streamId, envelope.payload.byteLength);
      break;
    }
    case FrameType.EndStream: {
      if (!stream.response.headersSent) throw new Error("END before response headers");
      stream.responseEnded = true;
      stream.response.end();
      maybeDeleteStream(session, envelope.streamId, stream);
      break;
    }
    case FrameType.ResetStream: {
      const reset = decodeResetStreamMetadata(envelope.payload);
      stream.cancelled = true;
      removeGatewayStream(session, envelope.streamId);
      session.outboundFlow.closeStream(envelope.streamId);
      if (!stream.response.headersSent) {
        writeGatewayError(stream.response, 502, reset.code);
      } else {
        stream.response.destroy();
      }
      break;
    }
    default:
      throw new Error(`unexpected client frame type ${envelope.type}`);
  }
}

function maybeDeleteStream(
  session: GatewaySession,
  streamId: number,
  stream: GatewayHttpStream,
): void {
  if (stream.requestEnded && stream.responseEnded) removeGatewayStream(session, streamId);
  if (stream.requestEnded && stream.responseEnded) session.outboundFlow.closeStream(streamId);
}

function removeGatewayStream(session: GatewaySession, streamId: number): void {
  const stream = session.streams.get(streamId);
  if (stream === undefined || !session.streams.delete(streamId)) return;
  clearGatewayStreamTimers(stream);
  if (session.streams.size === 0) session.lastStreamClosedAt = session.now();
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
  method: string | undefined,
  statusCode: number,
  headers: readonly (readonly [string, string])[],
  contentLength: number | undefined,
): boolean {
  if (
    method === "HEAD" ||
    (statusCode >= 100 && statusCode < 200) ||
    statusCode === 204 ||
    statusCode === 304
  ) {
    return true;
  }
  const contentType = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1]
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType === "text/event-stream") return false;
  return contentLength !== undefined;
}

async function handleReviewerUpgrade(
  sessions: ReadonlyMap<string, GatewaySession>,
  contentDomain: string,
  request: IncomingMessage,
  browserSocket: Duplex,
  head: Buffer,
  reviewer?: Principal,
): Promise<void> {
  const tunnelId = getTunnelId(request.headers.host, contentDomain);
  const session = tunnelId === undefined ? undefined : sessions.get(tunnelId);
  if (
    session === undefined ||
    !session.active ||
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
  const streamId = session.nextStreamId;
  session.nextStreamId += 2;
  const stream: GatewayWebSocketStream = {
    kind: "WEBSOCKET",
    browserSocket,
    pendingHead: head,
    responseStarted: false,
    upgraded: false,
    browserEnded: false,
    localEnded: false,
    cancelled: false,
    ...(reviewer === undefined ? {} : {
      reviewerAccountId: reviewer.accountId,
      reviewerAuthVersion: reviewer.authVersion,
      reviewerAuthorizedAt: session.now(),
    }),
  };
  session.streams.set(streamId, stream);
  session.metrics.increment("stream_opened");
  stream.durationTimer = setTimeout(() => {
    if (stream.cancelled) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId);
    session.outboundFlow.closeStream(streamId);
    browserSocket.destroy();
    void sendReset(session, streamId, "LIMIT_EXCEEDED");
  }, session.config.snapshot.maxStreamDurationMs);
  stream.durationTimer.unref();
  session.outboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);

  const cancel = () => {
    if (stream.cancelled || (stream.upgraded && stream.browserEnded)) return;
    stream.cancelled = true;
    removeGatewayStream(session, streamId);
    session.outboundFlow.closeStream(streamId);
    void sendReset(session, streamId, "DOWNSTREAM_CANCELLED");
  };
  browserSocket.once("error", cancel);
  browserSocket.once("close", cancel);

  try {
    await sendCarrierFrame(session.socket, {
      type: FrameType.OpenHttp,
      generation: session.generation,
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
    stream.cancelled = true;
    removeGatewayStream(session, streamId);
    session.outboundFlow.closeStream(streamId);
    writeRawError(browserSocket, 502, "RELAY_WRITE_FAILED");
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
          await sendFlowControlledData(session.socket, session.outboundFlow, {
            generation: session.generation,
            streamId,
            chunk: stream.pendingHead,
          });
        }
        attachBrowserRawForwarding(session, streamId, stream);
        stream.browserSocket.resume();
      }
      break;
    }
    case FrameType.Data:
      if (!stream.responseStarted) throw new Error("DATA before response headers");
      if (!stream.browserSocket.write(envelope.payload)) {
        session.socket.pause();
        await once(stream.browserSocket, "drain");
        session.socket.resume();
      }
      await sendWindowUpdate(session, streamId, envelope.payload.byteLength);
      break;
    case FrameType.EndStream:
      if (!stream.responseStarted) throw new Error("END before response headers");
      stream.localEnded = true;
      stream.browserSocket.end();
      if (!stream.upgraded || stream.browserEnded) {
        removeGatewayStream(session, streamId);
        session.outboundFlow.closeStream(streamId);
      }
      break;
    case FrameType.ResetStream: {
      stream.cancelled = true;
      removeGatewayStream(session, streamId);
      session.outboundFlow.closeStream(streamId);
      stream.browserSocket.destroy();
      break;
    }
    default:
      throw new Error(`unexpected WebSocket client frame type ${envelope.type}`);
  }
}

function attachBrowserRawForwarding(
  session: GatewaySession,
  streamId: number,
  stream: GatewayWebSocketStream,
): void {
  let sendQueue = Promise.resolve();
  stream.browserSocket.on("data", (chunk: Buffer) => {
    sendQueue = sendQueue
      .then(() =>
        sendFlowControlledData(session.socket, session.outboundFlow, {
          generation: session.generation,
          streamId,
          chunk,
        }),
      )
      .catch(() => {
        stream.cancelled = true;
        removeGatewayStream(session, streamId);
        session.outboundFlow.closeStream(streamId);
        stream.browserSocket.destroy();
      });
  });
  stream.browserSocket.once("end", () => {
    sendQueue = sendQueue
      .then(async () => {
        stream.browserEnded = true;
        await sendCarrierFrame(session.socket, {
          type: FrameType.EndStream,
          generation: session.generation,
          streamId,
        });
        if (stream.localEnded) {
          removeGatewayStream(session, streamId);
          session.outboundFlow.closeStream(streamId);
        }
      })
      .catch(() => undefined);
  });
}

async function sendWindowUpdate(
  session: GatewaySession,
  streamId: number,
  bytes: number,
): Promise<void> {
  await sendCarrierFrame(session.socket, {
    type: FrameType.WindowUpdate,
    generation: session.generation,
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

function toSafeErrorReason(value: unknown): string {
  const message = value instanceof Error ? value.message : "unknown carrier failure";
  return message.replace(/[\r\n]/g, " ").slice(0, 160);
}

async function sendReset(
  session: GatewaySession,
  streamId: number,
  code: string,
): Promise<void> {
  if (session.socket.readyState !== WebSocket.OPEN) return;
  await sendCarrierFrame(session.socket, {
    type: FrameType.ResetStream,
    generation: session.generation,
    streamId,
    payload: encodeMetadata({ code }),
  }).catch(() => undefined);
}

async function sendSessionConfig(session: GatewaySession): Promise<void> {
  session.configSendCount += 1;
  await sendCarrierFrame(session.socket, {
    type: FrameType.SessionConfig,
    generation: session.generation,
    streamId: 0,
    payload: encodeMetadata(session.config),
  });
}

function armActivationTimeout(
  session: GatewaySession,
  socket: WebSocket,
  activationTimeoutMs: number,
): void {
  if (!Number.isInteger(activationTimeoutMs) || activationTimeoutMs < 200) {
    throw new RangeError("activationTimeoutMs must be an integer of at least 200ms");
  }
  const retryDelay = Math.floor(activationTimeoutMs / 2);
  session.configAckTimer = setTimeout(() => {
    if (session.active || session.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (session.probe === undefined && session.configSendCount === 1) {
      void sendSessionConfig(session).catch(() => socket.close(1011, "config resend failed"));
    }
    session.configAckTimer = setTimeout(() => {
      if (session.active || session.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      void rejectCarrier(
        socket,
        session.generation,
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
): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Gateway must be listening before a Session is provisioned");
  }
  const protocol = secure ? "https" : "http";
  const defaultPort = secure ? 443 : 80;
  const port = address.port === defaultPort ? "" : `:${address.port}`;
  return `${protocol}://${tunnelId}.${contentDomain}${port}/`;
}

function getTunnelId(
  host: string | undefined,
  contentDomain: string,
): string | undefined {
  if (host === undefined) return undefined;
  const hostname = host.toLowerCase().split(":", 1)[0];
  const suffix = `.${contentDomain.toLowerCase()}`;
  if (hostname === undefined || !hostname.endsWith(suffix)) return undefined;
  const tunnelId = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tunnelId)
    ? tunnelId
    : undefined;
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
