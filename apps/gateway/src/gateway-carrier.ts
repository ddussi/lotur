import type { createGatewaySessions } from "./gateway-session-lifecycle.ts";
import { disposeActivationCandidate } from "./gateway-session.ts";
import {
  type GatewayTransportEpoch,
  type GatewaySession,
  captureGatewayTransport,
  isCurrentGatewayTransport,
  isCurrentGatewaySessionTransport,
} from "./gateway-session.ts";
import { handleClientFrame, sendWindowUpdate } from "./gateway-streams.ts";
import { toSafeErrorReason } from "./gateway-async.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type { DeveloperAuthorization } from "../../../packages/auth/src/index.ts";
import {
  decodeEnvelope,
  decodeConfigAppliedMetadata,
  decodeHelloMetadata,
  decodeWindowUpdate,
  encodeMetadata,
  createSessionConfigSnapshot,
  digestSessionConfig,
  FrameType,
  INITIAL_SESSION_STATE,
  isResumeAllowed,
  SessionTransitionError,
  transitionSession,
  type ConnectionErrorCode,
  type ConfigAppliedMetadata,
  type SessionPolicy,
  type SessionLimits,
} from "../../../packages/protocol/src/index.ts";
import {
  INITIAL_CONNECTION_WINDOW_BYTES,
  INITIAL_STREAM_WINDOW_BYTES,
  OutboundFlowWindow,
  sendCarrierFrame,
  sendFlowControlledData,
} from "../../../packages/relay/src/index.ts";
import { GatewayStreamIds } from "./gateway-stream-ids.ts";
import { GatewayInboundFlow } from "./inbound-flow.ts";
import type { GatewayMetrics } from "./metrics.ts";
import { resumeOwnerAuthorizationMatches } from "./resume-authorization.ts";
import type { GatewayEventSink } from "./gateway-session.ts";

type CarrierContext = Readonly<{
  sessionOwner: ReturnType<typeof createGatewaySessions>;
  developerAuthorization: DeveloperAuthorization | undefined;
  releasePendingCarrier(): void;
  config: Readonly<{
    requireAuthorization: boolean;
    sessionPolicy: SessionPolicy;
    sessionLimits: SessionLimits;
    activationTimeoutMs: number;
    maxPendingCarrierFrames: number;
    maxPendingCarrierBytes: number;
  }>;
  admission: Readonly<{
    canAdmitNewTunnel(accountId: string | undefined, tunnelId?: string): boolean;
    canActivateTunnel(session: GatewaySession): boolean;
    isReady(): boolean;
  }>;
  metrics: GatewayMetrics;
  emit: GatewayEventSink;
  now(): number;
  shareUrlForTunnel(tunnelId: string): string;
  resumeHmacKey: Uint8Array;
}>;

export function attachGatewayCarrier(socket: WebSocket, input: CarrierContext): void {
  const {
    sessionOwner,
    developerAuthorization,
    releasePendingCarrier,
    config,
    metrics,
    emit,
    now,
    admission,
    shareUrlForTunnel,
    resumeHmacKey,
  } = input;
  const {
    sessions,
    expireGatewaySession,
    terminateGatewaySession,
    disposeReviewBinding,
    applySessionTransition,
  } = sessionOwner;
  const {
    sessionPolicy,
    sessionLimits,
    activationTimeoutMs,
    maxPendingCarrierFrames,
    maxPendingCarrierBytes,
  } = config;
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
            config.requireAuthorization &&
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
            if (!admission.canAdmitNewTunnel(developerAuthorization?.accountId, hello.tunnelId)) {
              await rejectCarrier(socket, 0, "RELAY_NOT_READY", 1_000);
              return;
            }
            const resumeSecret = randomBytes(32).toString("base64url");
            const provisionId = randomBytes(16).toString("base64url");
            const generation = 1;
            const shareUrl = shareUrlForTunnel(hello.tunnelId);
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
              outboundFlow: new OutboundFlowWindow(INITIAL_CONNECTION_WINDOW_BYTES),
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
              ...(developerAuthorization === undefined
                ? {}
                : {
                    ownerAccountId: developerAuthorization.accountId,
                    ownerAuthVersion: developerAuthorization.accountAuthVersion,
                  }),
            };
            sessionOwner.register(session);
            metrics.increment("tunnel_provisioned");
            emit("tunnel.provisioned", session);
          } else {
            const existing = sessions.get(hello.tunnelId);
            if (
              existing === undefined ||
              existing.terminal ||
              existing.lifecycle.status !== "RECONNECTING" ||
              !isResumeAllowed(now(), existing.lifecycle.disconnectedAt, sessionPolicy) ||
              !resumeSecretMatches(resumeHmacKey, hello.resumeSecret, existing.resumeDigest)
            ) {
              await rejectCarrier(socket, 0, "RESUME_REJECTED");
              return;
            }
            if (
              !resumeOwnerAuthorizationMatches(
                existing.ownerAccountId === undefined || existing.ownerAuthVersion === undefined
                  ? undefined
                  : {
                      accountId: existing.ownerAccountId,
                      accountAuthVersion: existing.ownerAuthVersion,
                    },
                developerAuthorization,
              )
            ) {
              await rejectCarrier(socket, 0, "AUTH_FAILED");
              return;
            }
            if (
              existing.config.snapshot.localOriginFingerprint !== hello.localOriginFingerprint ||
              existing.config.snapshot.originProjection !== hello.originProjection
            ) {
              await rejectCarrier(socket, 0, "CONFIG_APPLY_FAILED");
              return;
            }
            const attemptId = randomBytes(16).toString("base64url");
            try {
              const nextLifecycle = transitionSession(
                existing.lifecycle,
                {
                  type: "START_RESUME",
                  now: now(),
                  attemptId,
                },
                sessionPolicy,
              );
              if (!applySessionTransition(existing, nextLifecycle)) {
                await rejectCarrier(socket, 0, "RESUME_REJECTED");
                return;
              }
              if (nextLifecycle.status !== "RECONNECTING") {
                throw new Error("resume start did not remain RECONNECTING");
              }
            } catch (error) {
              if (error instanceof SessionTransitionError && error.code === "RESUME_IN_PROGRESS") {
                await rejectCarrier(socket, 0, "RESUME_IN_PROGRESS", 500);
                return;
              }
              throw error;
            }
            session = existing;
            resumeAttemptId = attemptId;
            disposeActivationCandidate(existing);
            existing.socket = socket;
            existing.outboundFlow = new OutboundFlowWindow(INITIAL_CONNECTION_WINDOW_BYTES);
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
            if (sessions.get(session.tunnelId) !== session || session.socket !== socket) return;
          }
          const configTransport = captureGatewayTransport(session);
          await sendSessionConfig(session, configTransport);
          if (!isCurrentGatewaySessionTransport(sessions, session, configTransport)) {
            return;
          }
          armActivationTimeout(session, configTransport, activationTimeoutMs);
          clearTimeout(helloTimer);
          return;
        }
        if (envelope.generation !== session.generation) {
          throw new Error("stale Carrier generation");
        }
        if (session.terminal || sessions.get(session.tunnelId) !== session) return;
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
            if (connectionMode === "create" && applied.provisionReceipt !== session.provisionId) {
              await rejectCarrier(socket, session.generation, "PROVISION_RECEIPT_FAILED");
              return;
            }
            if (!applied.localOriginReady) {
              await rejectCarrier(socket, session.generation, "LOCAL_ORIGIN_UNAVAILABLE");
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
              probeTransport.outboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);
              probeTransport.inboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);
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
              )
                return;
              await sendFlowControlledData(probeTransport.socket, probeTransport.outboundFlow, {
                generation: probeTransport.generation,
                streamId,
                chunk: nonce,
              });
              if (
                !isCurrentGatewaySessionTransport(sessions, session, probeTransport) ||
                session.probe !== probe
              )
                return;
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
            session.outboundFlow.update(envelope.streamId, decodeWindowUpdate(envelope.payload));
            return;
          }
          if (envelope.type === FrameType.Data) {
            const probeTransport = captureGatewayTransport(session);
            probeTransport.inboundFlow.consume(probe.streamId, envelope.payload.byteLength);
            probe.receivedBytes += envelope.payload.byteLength;
            if (probe.receivedBytes > probe.expected.byteLength) {
              throw new Error("Relay probe payload is too large");
            }
            probe.received.push(Buffer.from(envelope.payload));
            await sendWindowUpdate(probeTransport, probe.streamId, envelope.payload.byteLength);
            if (
              !isCurrentGatewaySessionTransport(sessions, session, probeTransport) ||
              session.probe !== probe
            )
              return;
            probeTransport.inboundFlow.release(probe.streamId, envelope.payload.byteLength);
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
            if (!admission.isReady()) {
              await rejectCarrier(socket, session.generation, "RELAY_NOT_READY");
              return;
            }
            if (!admission.canActivateTunnel(session)) {
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
              const nextLifecycle = transitionSession(
                session.lifecycle,
                {
                  type: "RESUME_COMMITTED",
                  now: now(),
                  attemptId: resumeAttemptId,
                },
                sessionPolicy,
              );
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
              !isCurrentGatewaySessionTransport(sessions, session, activationTransport) ||
              session.lifecycle.status !== "ACTIVE" ||
              session.lifecycle.generation !== activationTransport.generation
            )
              return;
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
          terminateGatewaySession(session, "session closed", 1000);
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
    )
      return;
    const current = session;
    const wasActive = current.lifecycle.status === "ACTIVE";
    disposeActivationCandidate(current);
    sessionOwner.closeGatewayStreams(current, "TUNNEL_OFFLINE");
    if (current.terminal) {
      metrics.increment("tunnel_closed");
      emit("tunnel.closed", current);
      disposeReviewBinding(current);
      sessionOwner.remove(current);
      return;
    }
    if (current.lifecycle.status === "CREATING") {
      metrics.increment("activation_failed");
      emit("tunnel.activation_failed", current);
      sessionOwner.remove(current);
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
        const nextLifecycle = transitionSession(
          current.lifecycle,
          {
            type: "RESUME_FAILED",
            now: now(),
            attemptId: resumeAttemptId,
          },
          sessionPolicy,
        );
        if (!applySessionTransition(current, nextLifecycle)) return;
      }
      metrics.increment("activation_failed");
      emit("tunnel.activation_failed", current);
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

function sameConfigApplied(left: ConfigAppliedMetadata, right: ConfigAppliedMetadata): boolean {
  return (
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.result === right.result &&
    left.localOriginReady === right.localOriginReady &&
    left.provisionReceipt === right.provisionReceipt
  );
}

function resumeSecretMatches(key: Uint8Array, secret: string, expectedDigest: Buffer): boolean {
  const actualDigest = digestResumeSecret(key, secret);
  return (
    actualDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(actualDigest, expectedDigest)
  );
}
