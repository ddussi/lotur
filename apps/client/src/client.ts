import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { connect as connectTcp, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, type RawData } from "ws";

import {
  decodeEnvelope,
  decodeConnectionErrorMetadata,
  decodeOpenProbeMetadata,
  decodeOpenHttpMetadata,
  decodeResetStreamMetadata,
  decodeSessionConfigMetadata,
  decodeSessionProvisionedMetadata,
  decodeSessionActiveMetadata,
  decodeWindowUpdate,
  encodeMetadata,
  encodeWindowUpdate,
  CARRIER_PROFILE,
  FrameType,
  MAX_ENVELOPE_PAYLOAD_BYTES,
  type HeaderPair,
  type OriginProjection,
  type SessionConfigMetadata,
  type SessionConfigSnapshot,
  type SessionProvisionedMetadata,
} from "../../../packages/protocol/src/index.ts";
import {
  headerPairsToOutgoingHeaders,
  projectRequestHeaders,
  projectResponseHeaders,
  rawHeadersToPairs,
  sanitizeHopByHopHeaders,
} from "../../../packages/proxy/src/index.ts";
import {
  OutboundFlowWindow,
  sendCarrierFrame,
  sendFlowControlledData,
} from "../../../packages/relay/src/index.ts";
import { InboundFlowWindow } from "./inbound-flow.ts";
import { ApplicationOperationBudget } from "./application-operation-budget.ts";
import { RemoteStreamLifecycle } from "./remote-stream-lifecycle.ts";
import { waitForWritableDrain } from "./writable-drain.ts";

const ENVELOPE_HEADER_BYTES = 16;
const MAX_PENDING_ACTIVATION_FRAMES = 64;
const MAX_PENDING_CONTROL_FRAMES = 64;
const MAX_PENDING_STREAM_OPERATIONS = 1_024;
const MAX_PENDING_APPLICATION_OPERATIONS = 4_096;
export const DEFAULT_CARRIER_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_CARRIER_ACTIVATION_TIMEOUT_MS = 15_000;
export const DEFAULT_CARRIER_CLOSE_TIMEOUT_MS = 1_000;

type ClientStream = {
  readonly kind: "HTTP" | "WEBSOCKET";
  readonly request: ClientRequest;
  response?: IncomingMessage;
  localSocket?: Duplex;
  requestEnded: boolean;
  requestBytes: number;
  responseEnded: boolean;
  cancelled: boolean;
  inboundQueue: Promise<void>;
  pendingInboundOperations: number;
  responseHeaderTimer?: NodeJS.Timeout;
  inactivityTimer?: NodeJS.Timeout;
  durationTimer?: NodeJS.Timeout;
  terminate?: (code: string) => void;
};

type ResetStreamSender = (streamId: number, code: string) => void;

const RESERVED_GATEWAY_COOKIES = new Set([
  "__Host-rt_control",
  "__Host-rt_session",
  "rt_control_dev",
  "rt_session_dev",
]);

export class TunnelConnectionError extends Error {
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(code: string, retryAfterMs?: number) {
    super(`Gateway rejected the Carrier: ${code}`);
    this.name = "TunnelConnectionError";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export type TunnelClientInput = Readonly<{
  gatewayUrl: string;
  tunnelId: string;
  localOrigin: string;
  resumeSecret?: string;
  carrierCredential?: string;
  originProjection?: OriginProjection;
  pinnedLocalAddress?: string;
  handshakeTimeoutMs?: number;
  activationTimeoutMs?: number;
  closeTimeoutMs?: number;
}>;

export type TunnelClientClosure = Awaited<TunnelClient["closed"]>;

export type TunnelClient = Readonly<{
  ready: Promise<Readonly<{
    generation: number;
    resumeSecret: string;
    tunnelId: string;
    shareUrl: string;
    pinnedLocalAddress: string;
    readiness: ReturnType<typeof decodeSessionActiveMetadata>["readiness"];
  }>>;
  activationCandidate: Promise<Readonly<{
    resumeSecret: string;
    pinnedLocalAddress: string;
  }> | undefined>;
  closed: Promise<Readonly<{
    reason: "closed" | "disconnected" | "failed";
    error?: Error;
  }>>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
}>;

export function connectTunnelClient(input: TunnelClientInput): TunnelClient {
  const origin = parseLoopbackOrigin(input.localOrigin);
  const handshakeTimeoutMs = positiveTimeout(
    input.handshakeTimeoutMs ?? DEFAULT_CARRIER_HANDSHAKE_TIMEOUT_MS,
    "handshakeTimeoutMs",
  );
  const activationTimeoutMs = positiveTimeout(
    input.activationTimeoutMs ?? DEFAULT_CARRIER_ACTIVATION_TIMEOUT_MS,
    "activationTimeoutMs",
  );
  const closeTimeoutMs = positiveTimeout(
    input.closeTimeoutMs ?? DEFAULT_CARRIER_CLOSE_TIMEOUT_MS,
    "closeTimeoutMs",
  );
  const originProjection = input.originProjection ?? "local-view";
  const localOriginFingerprint = fingerprintLocalOrigin(origin);
  const socket = new WebSocket(input.gatewayUrl, CARRIER_PROFILE, {
    autoPong: false,
    perMessageDeflate: false,
    maxPayload: ENVELOPE_HEADER_BYTES + MAX_ENVELOPE_PAYLOAD_BYTES,
    handshakeTimeout: handshakeTimeoutMs,
    ...(input.carrierCredential === undefined ? {} : {
      headers: { authorization: `Bearer ${input.carrierCredential}` },
    }),
  });
  const streams = new Map<number, ClientStream>();
  const streamLifecycle = new RemoteStreamLifecycle();
  const applicationOperations = new ApplicationOperationBudget(
    MAX_PENDING_APPLICATION_OPERATIONS,
  );
  let outboundFlow: OutboundFlowWindow | undefined;
  let inboundFlow: InboundFlowWindow | undefined;
  let provisioned: SessionProvisionedMetadata | undefined;
  let configured: SessionConfigMetadata | undefined;
  let localOriginReady: boolean | undefined;
  let localConnectAddress: string | undefined;
  let probeStreamId: number | undefined;
  let probeEnded = false;
  let resumeSecret = input.resumeSecret;
  let readyResolve!: (value: Readonly<{
    generation: number;
    resumeSecret: string;
    tunnelId: string;
    shareUrl: string;
    pinnedLocalAddress: string;
    readiness: ReturnType<typeof decodeSessionActiveMetadata>["readiness"];
  }>) => void;
  let readyReject!: (error: Error) => void;
  let active = false;
  let generation = 0;
  let closeIntent: "closed" | "disconnected" | undefined;
  let failure: Error | undefined;
  let resourcesClosed = false;
  let protocolClosing = false;
  let protocolCloseTimer: NodeJS.Timeout | undefined;
  let activationCandidateSettled = false;
  let activationTimer: NodeJS.Timeout | undefined;
  let pendingPongs = 0;
  let activationCandidateResolve!: (value: Readonly<{
    resumeSecret: string;
    pinnedLocalAddress: string;
  }> | undefined) => void;
  let closedResolve!: (value: Readonly<{
    reason: "closed" | "disconnected" | "failed";
    error?: Error;
  }>) => void;
  const closed = new Promise<Readonly<{
    reason: "closed" | "disconnected" | "failed";
    error?: Error;
  }>>((resolve) => {
    closedResolve = resolve;
  });
  const activationCandidate = new Promise<Readonly<{
    resumeSecret: string;
    pinnedLocalAddress: string;
  }> | undefined>((resolve) => {
    activationCandidateResolve = resolve;
  });
  const settleActivationCandidate = (value: Readonly<{
    resumeSecret: string;
    pinnedLocalAddress: string;
  }> | undefined) => {
    if (activationCandidateSettled) return;
    activationCandidateSettled = true;
    activationCandidateResolve(value);
  };
  const ready = new Promise<Readonly<{
    generation: number;
    resumeSecret: string;
    tunnelId: string;
    shareUrl: string;
    pinnedLocalAddress: string;
    readiness: ReturnType<typeof decodeSessionActiveMetadata>["readiness"];
  }>>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  socket.once("open", () => {
    if (socket.protocol !== CARRIER_PROFILE) {
      const error = new Error(`Carrier did not negotiate ${CARRIER_PROFILE}`);
      failure ??= error;
      readyReject(error);
      socket.close(1002, "subprotocol required");
      return;
    }
    activationTimer = setTimeout(() => {
      const error = new Error("Carrier activation timed out");
      failure ??= error;
      readyReject(error);
      socket.terminate();
    }, activationTimeoutMs);
    activationTimer.unref();
    void sendCarrierFrame(socket, {
      type: FrameType.Hello,
      generation: 0,
      streamId: 0,
      payload: encodeMetadata(
        input.resumeSecret === undefined
          ? {
              mode: "create",
              tunnelId: input.tunnelId,
              localOriginFingerprint,
              originProjection,
            }
          : {
              mode: "resume",
              tunnelId: input.tunnelId,
              resumeSecret: input.resumeSecret,
              localOriginFingerprint,
              originProjection,
            },
      ),
    }).catch(readyReject);
  });

  const closeForProtocolError = (error: unknown) => {
    if (protocolClosing) return;
    protocolClosing = true;
    failure ??= toError(error);
    if (!active) readyReject(failure);
    socket.close(1002, "protocol error");
    protocolCloseTimer = setTimeout(() => socket.terminate(), closeTimeoutMs);
    protocolCloseTimer.unref();
  };
  const resetStream: ResetStreamSender = (streamId, code) => {
    void settleBeforeDeadline(
      sendReset(socket, generation, streamId, code),
      Date.now() + closeTimeoutMs,
      `RESET_STREAM ${streamId} delivery`,
    ).catch((error: unknown) => {
      closeForProtocolError(new Error(
        `Failed to deliver RESET_STREAM ${streamId}`,
        { cause: error },
      ));
    });
  };
  socket.on("ping", () => {
    closeForProtocolError(new Error("Carrier WebSocket control PING is forbidden"));
  });
  socket.on("pong", () => {
    closeForProtocolError(new Error("Carrier WebSocket control PONG is forbidden"));
  });
  const dispatchActiveEnvelope = (envelope: ReturnType<typeof decodeEnvelope>) => {
    if (envelope.generation !== generation) {
      throw new Error("stale Carrier generation");
    }
    if (envelope.type === FrameType.Ping && envelope.streamId === 0) {
      if (envelope.payload.byteLength !== 0) throw new Error("PING payload must be empty");
      if (pendingPongs >= MAX_PENDING_CONTROL_FRAMES) {
        throw new Error("too many pending Carrier PING frames");
      }
      pendingPongs += 1;
      void sendCarrierFrame(socket, {
        type: FrameType.Pong,
        generation,
        streamId: 0,
      }).finally(() => {
        pendingPongs -= 1;
      }).catch(closeForProtocolError);
      return;
    }
    if (configured === undefined) throw new Error("active Session has no configuration");
    if (localConnectAddress === undefined) {
      throw new Error("active Session has no pinned local origin address");
    }
    handleGatewayFrame(
      socket,
      streams,
      streamLifecycle,
      applicationOperations,
      requireOutboundFlow(outboundFlow),
      requireInboundFlow(inboundFlow),
      origin,
      localConnectAddress,
      configured.snapshot,
      generation,
      envelope,
      closeForProtocolError,
      resetStream,
    );
  };

  let receiveQueue = Promise.resolve();
  let pendingActivationFrames = 0;
  socket.on("message", (data, isBinary) => {
    if (protocolClosing) return;
    if (active) {
      try {
        if (!isBinary) throw new Error("Carrier accepts binary frames only");
        dispatchActiveEnvelope(decodeEnvelope(asBytes(data)));
      } catch (error) {
        closeForProtocolError(error);
      }
      return;
    }
    pendingActivationFrames += 1;
    if (pendingActivationFrames > MAX_PENDING_ACTIVATION_FRAMES) {
      closeForProtocolError(new Error("too many pending Carrier activation frames"));
      return;
    }
    receiveQueue = receiveQueue
      .then(async () => {
        if (!isBinary) throw new Error("Carrier accepts binary frames only");
        const envelope = decodeEnvelope(asBytes(data));
        if (!active && envelope.type === FrameType.Ping && envelope.streamId === 0) {
          if (envelope.payload.byteLength !== 0) throw new Error("PING payload must be empty");
          await sendCarrierFrame(socket, {
            type: FrameType.Pong,
            generation: envelope.generation,
            streamId: 0,
          });
          return;
        }
        if (!active) {
          if (envelope.type === FrameType.ConnectionError && envelope.streamId === 0) {
            const failure = decodeConnectionErrorMetadata(envelope.payload);
            throw new TunnelConnectionError(failure.code, failure.retryAfterMs);
          }
          if (envelope.type === FrameType.SessionProvisioned && envelope.streamId === 0) {
            if (input.resumeSecret !== undefined || provisioned !== undefined) {
              throw new Error("unexpected SESSION_PROVISIONED");
            }
            const received = decodeSessionProvisionedMetadata(envelope.payload);
            if (received.tunnelId !== input.tunnelId) {
              throw new Error("SESSION_PROVISIONED tunnel mismatch");
            }
            provisioned = received;
            resumeSecret = received.resumeSecret;
            return;
          }
          if (envelope.type === FrameType.SessionConfig && envelope.streamId === 0) {
            const received = decodeSessionConfigMetadata(envelope.payload);
            if (
              received.snapshot.generation !== envelope.generation ||
              received.snapshot.localOriginFingerprint !== localOriginFingerprint ||
              received.snapshot.originProjection !== originProjection
            ) {
              throw new Error("SESSION_CONFIG does not match requested local origin");
            }
            if (input.resumeSecret === undefined && provisioned === undefined) {
              throw new Error("SESSION_CONFIG arrived before SESSION_PROVISIONED");
            }
            if (
              configured !== undefined &&
              (configured.revision !== received.revision || configured.digest !== received.digest)
            ) {
              throw new Error("SESSION_CONFIG changed within a candidate generation");
            }
            configured = received;
            generation = envelope.generation;
            outboundFlow ??= new OutboundFlowWindow(
              received.snapshot.initialConnectionWindowBytes,
            );
            inboundFlow ??= new InboundFlowWindow(
              received.snapshot.initialConnectionWindowBytes,
            );
            if (localOriginReady === undefined) {
              localConnectAddress = await (
                input.pinnedLocalAddress === undefined
                  ? resolveAndProbeLocalOrigin(origin)
                  : probePinnedLocalOrigin(origin, input.pinnedLocalAddress)
              ).catch(() => undefined);
              localOriginReady = localConnectAddress !== undefined;
            }
            if (localConnectAddress !== undefined && resumeSecret !== undefined) {
              settleActivationCandidate({ resumeSecret, pinnedLocalAddress: localConnectAddress });
            }
            await sendCarrierFrame(socket, {
              type: FrameType.ConfigApplied,
              generation,
              streamId: 0,
              payload: encodeMetadata({
                revision: received.revision,
                digest: received.digest,
                result: localOriginReady ? "APPLIED" : "REJECTED",
                localOriginReady,
                ...(provisioned === undefined
                  ? {}
                  : { provisionReceipt: provisioned.provisionId }),
              }),
            });
            return;
          }
          if (envelope.type === FrameType.OpenProbe) {
            if (configured === undefined || outboundFlow === undefined) {
              throw new Error("OPEN_PROBE arrived before configuration was applied");
            }
            const probe = decodeOpenProbeMetadata(envelope.payload);
            if (probeStreamId !== undefined) throw new Error("duplicate OPEN_PROBE");
            streamLifecycle.open(envelope.streamId);
            probeStreamId = envelope.streamId;
            outboundFlow.openStream(envelope.streamId, probe.initialWindowBytes);
            requireInboundFlow(inboundFlow).openStream(
              envelope.streamId,
              configured.snapshot.initialStreamWindowBytes,
            );
            return;
          }
          if (probeStreamId !== undefined && envelope.streamId === probeStreamId) {
            if (outboundFlow === undefined) throw new Error("Relay probe flow is unavailable");
            if (envelope.type === FrameType.WindowUpdate) {
              outboundFlow.update(
                envelope.streamId,
                decodeWindowUpdate(envelope.payload),
              );
              return;
            }
            if (envelope.type === FrameType.Data) {
              const receivedFlow = requireInboundFlow(inboundFlow);
              receivedFlow.consume(envelope.streamId, envelope.payload.byteLength);
              await sendWindowUpdate(
                socket,
                generation,
                envelope.streamId,
                envelope.payload.byteLength,
              );
              receivedFlow.release(envelope.streamId, envelope.payload.byteLength);
              await sendFlowControlledData(socket, outboundFlow, {
                generation,
                streamId: envelope.streamId,
                chunk: envelope.payload,
              });
              return;
            }
            if (envelope.type === FrameType.EndStream) {
              if (probeEnded) throw new Error("duplicate Relay probe END");
              probeEnded = true;
              streamLifecycle.close(envelope.streamId);
              inboundFlow?.closeStream(envelope.streamId);
              await sendCarrierFrame(socket, {
                type: FrameType.EndStream,
                generation,
                streamId: envelope.streamId,
              });
              return;
            }
          }
          if (envelope.type !== FrameType.SessionActive || envelope.streamId !== 0) {
            throw new Error("SESSION_ACTIVE must follow successful activation checks");
          }
          const activated = decodeSessionActiveMetadata(envelope.payload);
          if (
            envelope.generation !== activated.generation ||
            configured === undefined ||
            !probeEnded ||
            resumeSecret === undefined ||
            localConnectAddress === undefined ||
            activated.tunnelId !== input.tunnelId ||
            (provisioned !== undefined && activated.shareUrl !== provisioned.shareUrl)
          ) {
            throw new Error("SESSION_ACTIVE generation mismatch");
          }
          generation = activated.generation;
          active = true;
          if (activationTimer !== undefined) {
            clearTimeout(activationTimer);
            activationTimer = undefined;
          }
          if (probeStreamId !== undefined) outboundFlow?.closeStream(probeStreamId);
          readyResolve({
            ...activated,
            resumeSecret,
            pinnedLocalAddress: localConnectAddress,
          });
          return;
        }
        dispatchActiveEnvelope(envelope);
      })
      .finally(() => {
        pendingActivationFrames -= 1;
      })
      .catch(closeForProtocolError);
  });

  const fail = (error: Error) => {
    failure ??= error;
    if (protocolCloseTimer !== undefined) {
      clearTimeout(protocolCloseTimer);
      protocolCloseTimer = undefined;
    }
    if (activationTimer !== undefined) {
      clearTimeout(activationTimer);
      activationTimer = undefined;
    }
    if (!active) readyReject(error);
    settleActivationCandidate(undefined);
    if (resourcesClosed) return;
    resourcesClosed = true;
    for (const [streamId, stream] of streams) {
      stream.cancelled = true;
      clearClientStreamTimers(stream);
      stream.request.destroy(error);
      stream.response?.destroy(error);
      stream.localSocket?.destroy(error);
      inboundFlow?.closeStream(streamId);
    }
    streams.clear();
    outboundFlow?.close();
  };
  socket.once("error", fail);
  socket.once("close", (code, reason) => {
    const closeDescription = reason.byteLength === 0
      ? `Carrier closed with WebSocket code ${code}`
      : `Carrier closed with WebSocket code ${code}: ${reason.toString("utf8")}`;
    fail(failure ?? new Error(closeDescription));
    closedResolve(
      closeIntent === undefined
        ? { reason: "failed", error: failure ?? new Error(closeDescription) }
        : { reason: closeIntent },
    );
  });

  return {
    ready,
    activationCandidate,
    closed,
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      closeIntent = "closed";
      const deadline = Date.now() + closeTimeoutMs;
      if (active && socket.readyState === WebSocket.OPEN) {
        await settleBeforeDeadline(
          sendCarrierFrame(socket, {
            type: FrameType.CloseSession,
            generation,
            streamId: 0,
          }),
          deadline,
          "Carrier CLOSE_SESSION send",
        ).catch(() => undefined);
      } else {
        socket.close(1000, "client closed");
      }
      await closeSocketBeforeDeadline(socket, deadline);
    },
    async disconnect() {
      if (socket.readyState === WebSocket.CLOSED) return;
      closeIntent = "disconnected";
      const deadline = Date.now() + closeTimeoutMs;
      socket.terminate();
      await closeSocketBeforeDeadline(socket, deadline);
    },
  };
}

export function connectResilientTunnelClient(input: Readonly<{
  gatewayUrl: string;
  tunnelId: string;
  localOrigin: string;
  carrierCredential?: string;
  originProjection?: OriginProjection;
  reconnectGraceMs?: number;
  handshakeTimeoutMs?: number;
  activationTimeoutMs?: number;
  closeTimeoutMs?: number;
  connectionFactory?: (input: TunnelClientInput) => TunnelClient;
  issueCarrierCredential?: (
    purpose: "resume",
    tunnelId: string,
    signal: AbortSignal,
  ) => Promise<string>;
  onStatus?: (status: Readonly<{
    state: "reconnecting" | "active" | "failed";
    attempt?: number;
    error?: Error;
  }>) => void;
}>): TunnelClient {
  const reconnectGraceMs = input.reconnectGraceMs ?? 2 * 60_000;
  positiveTimeout(reconnectGraceMs, "reconnectGraceMs");
  const closeTimeoutMs = positiveTimeout(
    input.closeTimeoutMs ?? DEFAULT_CARRIER_CLOSE_TIMEOUT_MS,
    "closeTimeoutMs",
  );
  const connectionFactory = input.connectionFactory ?? connectTunnelClient;
  const stopController = new AbortController();
  let current = connectionFactory({
    gatewayUrl: input.gatewayUrl,
    tunnelId: input.tunnelId,
    localOrigin: input.localOrigin,
    ...(input.carrierCredential === undefined
      ? {}
      : { carrierCredential: input.carrierCredential }),
    ...(input.originProjection === undefined
      ? {}
      : { originProjection: input.originProjection }),
    ...(input.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
    ...(input.activationTimeoutMs === undefined
      ? {}
      : { activationTimeoutMs: input.activationTimeoutMs }),
    closeTimeoutMs,
  });
  let activation: Awaited<TunnelClient["ready"]> | undefined;
  let stopped = false;
  let closureSettled = false;
  let closedResolve!: (value: TunnelClientClosure) => void;
  const closed = new Promise<TunnelClientClosure>((resolve) => {
    closedResolve = resolve;
  });
  const settleClosure = (value: TunnelClientClosure) => {
    if (closureSettled) return;
    closureSettled = true;
    closedResolve(value);
  };

  let initialActiveReported = false;
  const ready = establishInitial().then((value) => {
    activation = value;
    if (!initialActiveReported) input.onStatus?.({ state: "active" });
    void supervise(current);
    return value;
  }).catch((error: unknown) => {
    const failure = toError(error);
    stopped = true;
    input.onStatus?.({ state: "failed", error: failure });
    settleClosure({ reason: "failed", error: failure });
    throw failure;
  });

  async function establishInitial(): Promise<Awaited<TunnelClient["ready"]>> {
    const initial = current;
    try {
      return await initial.ready;
    } catch (error) {
      const failure = toError(error);
      const context = await initial.activationCandidate;
      await initial.closed;
      if (context === undefined || !isTransientReconnectError(failure)) throw failure;
      const resumed = await reconnect(context, failure);
      initialActiveReported = true;
      return resumed;
    }
  }

  async function supervise(client: TunnelClient): Promise<void> {
    const outcome = await client.closed;
    if (current !== client) return;
    if (stopped || outcome.reason === "closed") {
      settleClosure({ reason: "closed" });
      return;
    }
    if (activation === undefined) {
      const error = outcome.error ?? new Error("Carrier closed before activation");
      settleClosure({ reason: "failed", error });
      return;
    }

    try {
      activation = await reconnect({
        resumeSecret: activation.resumeSecret,
        pinnedLocalAddress: activation.pinnedLocalAddress,
      }, outcome.error ?? new Error("Carrier disconnected"));
      void supervise(current);
    } catch (error) {
      if (stopped) {
        settleClosure({ reason: "closed" });
        return;
      }
      const failure = toError(error);
      stopped = true;
      input.onStatus?.({ state: "failed", error: failure });
      settleClosure({ reason: "failed", error: failure });
    }
  }

  async function reconnect(
    context: Readonly<{ resumeSecret: string; pinnedLocalAddress: string }>,
    initialError: Error,
  ): Promise<Awaited<TunnelClient["ready"]>> {
    const deadline = Date.now() + reconnectGraceMs;
    let attempt = 0;
    let lastError = initialError;
    const reconnectDeadlineController = new AbortController();
    const reconnectDeadlineTimer = setTimeout(
      () => reconnectDeadlineController.abort(
        new Error("Carrier reconnect deadline exceeded"),
      ),
      Math.max(1, deadline - Date.now()),
    );
    reconnectDeadlineTimer.unref();
    const reconnectSignal = AbortSignal.any([
      stopController.signal,
      reconnectDeadlineController.signal,
    ]);
    try {
      await settleBeforeDeadline(
        delay(Math.min(50, reconnectGraceMs), undefined, { signal: reconnectSignal }),
        deadline,
        "initial reconnect delay",
        reconnectSignal,
      );
      while (!stopped && Date.now() < deadline) {
        attempt += 1;
        input.onStatus?.({ state: "reconnecting", attempt, error: lastError });
        let candidate: TunnelClient | undefined;
        try {
          const credentialRequest = input.issueCarrierCredential?.(
            "resume",
            input.tunnelId,
            reconnectSignal,
          );
          const credential = credentialRequest === undefined
            ? undefined
            : await settleBeforeDeadline(
                credentialRequest,
                deadline,
                "Carrier credential issuance",
                reconnectSignal,
              );
          if (stopped) throw new Error("Tunnel client stopped during reconnect");
          candidate = connectionFactory({
            gatewayUrl: input.gatewayUrl,
            tunnelId: input.tunnelId,
            localOrigin: input.localOrigin,
            resumeSecret: context.resumeSecret,
            pinnedLocalAddress: context.pinnedLocalAddress,
            ...(credential === undefined ? {} : { carrierCredential: credential }),
            ...(input.originProjection === undefined
              ? {}
              : { originProjection: input.originProjection }),
            ...(input.handshakeTimeoutMs === undefined
              ? {}
              : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
            ...(input.activationTimeoutMs === undefined
              ? {}
              : { activationTimeoutMs: input.activationTimeoutMs }),
            closeTimeoutMs,
          });
          current = candidate;
          const resumed = await settleBeforeDeadline(
            candidate.ready,
            deadline,
            "Carrier resume activation",
            reconnectSignal,
          );
          input.onStatus?.({ state: "active", attempt });
          return resumed;
        } catch (error) {
          lastError = toError(error);
          if (candidate !== undefined) {
            void candidate.disconnect().catch(() => undefined);
            await settleBeforeDeadline(
              candidate.closed,
              Math.min(deadline, Date.now() + closeTimeoutMs),
              "failed Carrier shutdown",
              stopController.signal,
            ).catch(() => undefined);
          }
          if (stopped) break;
          if (!isTransientReconnectError(lastError)) break;
          const requestedDelay = lastError instanceof TunnelConnectionError
            ? lastError.retryAfterMs
            : undefined;
          const exponentialDelay = Math.min(2_000, 100 * 2 ** Math.min(attempt - 1, 4));
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await settleBeforeDeadline(
            delay(
              Math.min(remaining, requestedDelay ?? exponentialDelay),
              undefined,
              { signal: reconnectSignal },
            ),
            deadline,
            "reconnect backoff",
            reconnectSignal,
          );
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("Carrier reconnect deadline exceeded", { cause: lastError });
      }
      throw lastError;
    } finally {
      clearTimeout(reconnectDeadlineTimer);
      if (!reconnectDeadlineController.signal.aborted) {
        reconnectDeadlineController.abort(new Error("Carrier reconnect attempt finished"));
      }
    }
  }

  return {
    ready,
    activationCandidate: ready.then(
      (value) => ({
        resumeSecret: value.resumeSecret,
        pinnedLocalAddress: value.pinnedLocalAddress,
      }),
      () => undefined,
    ),
    closed,
    async close() {
      if (stopped) {
        settleClosure({ reason: "closed" });
        return;
      }
      stopped = true;
      stopController.abort(new Error("Tunnel client closed"));
      await settleBeforeDeadline(
        current.close(),
        Date.now() + closeTimeoutMs,
        "Tunnel client close",
      ).catch(() => {
        void current.disconnect().catch(() => undefined);
      });
      settleClosure({ reason: "closed" });
    },
    async disconnect() {
      await current.disconnect();
    },
  };
}

function handleGatewayFrame(
  socket: WebSocket,
  streams: Map<number, ClientStream>,
  streamLifecycle: RemoteStreamLifecycle,
  applicationOperations: ApplicationOperationBudget,
  outboundFlow: OutboundFlowWindow,
  inboundFlow: InboundFlowWindow,
  origin: URL,
  localConnectAddress: string,
  configuration: SessionConfigSnapshot,
  generation: number,
  envelope: ReturnType<typeof decodeEnvelope>,
  onProtocolError: (error: Error) => void,
  resetStream: ResetStreamSender,
): void {
  if (envelope.type === FrameType.OpenHttp) {
    if (streams.size >= configuration.maxConcurrentStreams) {
      throw new Error("Gateway exceeded configured concurrent stream limit");
    }
    const metadata = decodeOpenHttpMetadata(envelope.payload);
    streamLifecycle.open(envelope.streamId);
    outboundFlow.openStream(envelope.streamId, metadata.initialWindowBytes);
    inboundFlow.openStream(
      envelope.streamId,
      configuration.initialStreamWindowBytes,
    );
    const localRequest = request({
      protocol: origin.protocol,
      hostname: localConnectAddress,
      port: origin.port,
      method: metadata.method,
      path: metadata.path,
      headers: toLocalHeaders(
        metadata.headers,
        origin,
        configuration,
        metadata.kind,
      ),
    });
    const stream: ClientStream = {
      kind: metadata.kind,
      request: localRequest,
      requestEnded: metadata.requestBodyEnded,
      requestBytes: 0,
      responseEnded: false,
      cancelled: false,
      inboundQueue: Promise.resolve(),
      pendingInboundOperations: 0,
    };
    streams.set(envelope.streamId, stream);
    const terminate = (code: string) => {
      if (stream.cancelled) return;
      const error = new Error(code);
      cancelClientStream(
        streams,
        streamLifecycle,
        outboundFlow,
        inboundFlow,
        envelope.streamId,
        stream,
        "LOCAL_RESET",
      );
      stream.request.destroy(error);
      stream.response?.destroy(error);
      stream.localSocket?.destroy(error);
      resetStream(envelope.streamId, code);
    };
    stream.terminate = terminate;
    stream.durationTimer = setTimeout(
      () => terminate("LIMIT_EXCEEDED"),
      configuration.maxStreamDurationMs,
    );
    stream.durationTimer.unref();
    touchClientStream(stream, configuration.streamInactivityTimeoutMs);

    if (metadata.kind === "WEBSOCKET") {
      localRequest.once("upgrade", (response, localSocket, head) => {
        if (!hasValidWebSocketUpgrade(metadata.headers, response)) {
          localSocket.destroy();
          terminate("INVALID_WEBSOCKET_ACCEPT");
          return;
        }
        clearResponseHeaderTimer(stream);
        touchClientStream(stream, configuration.streamInactivityTimeoutMs);
        stream.response = response;
        stream.localSocket = localSocket;
        void activateLocalWebSocket(
          socket,
          streams,
          streamLifecycle,
          outboundFlow,
          inboundFlow,
          generation,
          resetStream,
          envelope.streamId,
          stream,
          response,
          localSocket,
          head,
          origin,
          configuration,
        );
      });
    }
    localRequest.once("response", (response) => {
      clearResponseHeaderTimer(stream);
      touchClientStream(stream, configuration.streamInactivityTimeoutMs);
      stream.response = response;
      void forwardLocalResponse(
        socket,
        streams,
        streamLifecycle,
        outboundFlow,
          inboundFlow,
          generation,
          resetStream,
          envelope.streamId,
        stream,
        response,
        origin,
        configuration,
      );
    });
    localRequest.once("error", () => {
      if (stream.cancelled) return;
      cancelClientStream(
        streams,
        streamLifecycle,
        outboundFlow,
        inboundFlow,
        envelope.streamId,
        stream,
        "LOCAL_RESET",
      );
      resetStream(envelope.streamId, "LOCAL_ORIGIN_ERROR");
    });
    if (metadata.requestBodyEnded) {
      localRequest.end();
      armResponseHeaderTimer(stream, configuration.responseHeaderTimeoutMs);
    }
    return;
  }

  if (streamLifecycle.isRetired(envelope.streamId)) {
    validateRetiredGatewayFrame(envelope, inboundFlow);
    return;
  }
  const stream = streams.get(envelope.streamId);
  streamLifecycle.requireActive(envelope.streamId);
  if (stream === undefined || stream.cancelled) {
    throw new Error(`active stream ${envelope.streamId} has no client state`);
  }
  if (envelope.type === FrameType.WindowUpdate) {
    outboundFlow.update(envelope.streamId, decodeWindowUpdate(envelope.payload));
    return;
  }
  if (envelope.type === FrameType.Data) {
    if (stream.kind === "HTTP") {
      if (stream.requestBytes + envelope.payload.byteLength > configuration.maxRequestBodyBytes) {
        throw new Error("Gateway exceeded configured request body limit");
      }
      stream.requestBytes += envelope.payload.byteLength;
    }
    touchClientStream(stream, configuration.streamInactivityTimeoutMs);
    inboundFlow.consume(envelope.streamId, envelope.payload.byteLength);
  }

  switch (envelope.type) {
    case FrameType.Data: {
      const bytes = envelope.payload.byteLength;
      enqueueInboundOperation(stream, async () => {
        if (stream.cancelled) return;
        if (stream.kind === "WEBSOCKET" && stream.localSocket !== undefined) {
          if (!stream.localSocket.write(envelope.payload)) {
            await waitForWritableDrain(stream.localSocket);
          }
        } else {
          if (stream.requestEnded) throw new Error("request DATA after END");
          if (!stream.request.write(envelope.payload)) {
            await waitForWritableDrain(stream.request);
          }
        }
        if (stream.cancelled) return;
        await sendWindowUpdate(socket, generation, envelope.streamId, bytes);
        if (!stream.cancelled) inboundFlow.release(envelope.streamId, bytes);
      }, applicationOperations, onProtocolError);
      break;
    }
    case FrameType.EndStream:
      enqueueInboundOperation(stream, async () => {
        if (stream.cancelled) return;
        if (stream.kind === "WEBSOCKET" && stream.localSocket !== undefined) {
          if (stream.requestEnded) throw new Error("duplicate raw END");
          stream.requestEnded = true;
          stream.localSocket.end();
        } else {
          if (stream.requestEnded) throw new Error("duplicate request END");
          stream.requestEnded = true;
          stream.request.end();
          armResponseHeaderTimer(stream, configuration.responseHeaderTimeoutMs);
        }
        maybeDeleteStream(
          streams,
          streamLifecycle,
          outboundFlow,
          inboundFlow,
          envelope.streamId,
          stream,
        );
      }, applicationOperations, onProtocolError);
      break;
    case FrameType.ResetStream: {
      const reset = decodeResetStreamMetadata(envelope.payload);
      cancelClientStream(
        streams,
        streamLifecycle,
        outboundFlow,
        inboundFlow,
        envelope.streamId,
        stream,
      );
      const error = new Error(reset.code);
      stream.request.destroy(error);
      stream.response?.destroy(error);
      stream.localSocket?.destroy(error);
      break;
    }
    default:
      throw new Error(`unexpected gateway frame type ${envelope.type}`);
  }
}

function validateRetiredGatewayFrame(
  envelope: ReturnType<typeof decodeEnvelope>,
  inboundFlow: InboundFlowWindow,
): void {
  switch (envelope.type) {
    case FrameType.Data:
      if (envelope.payload.byteLength === 0) {
        throw new Error("Gateway DATA payload must not be empty");
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
      throw new Error(`unexpected retired gateway frame type ${envelope.type}`);
  }
}

async function activateLocalWebSocket(
  socket: WebSocket,
  streams: Map<number, ClientStream>,
  streamLifecycle: RemoteStreamLifecycle,
  outboundFlow: OutboundFlowWindow,
  inboundFlow: InboundFlowWindow,
  generation: number,
  resetStream: ResetStreamSender,
  streamId: number,
  stream: ClientStream,
  response: IncomingMessage,
  localSocket: Duplex,
  head: Buffer,
  origin: URL,
  configuration: SessionConfigSnapshot,
): Promise<void> {
  localSocket.pause();
  stream.requestEnded = false;
  let localEnded = false;
  let producerBusy = true;
  let pendingProducer: Promise<void> | undefined;
  const failLocalSocket = () => {
    if (stream.cancelled) return;
    cancelClientStream(
      streams,
      streamLifecycle,
      outboundFlow,
      inboundFlow,
      streamId,
      stream,
      "LOCAL_RESET",
    );
    localSocket.destroy();
    resetStream(streamId, "LOCAL_IO_ERROR");
  };
  localSocket.once("error", failLocalSocket);
  localSocket.once("close", () => {
    if (!localEnded) failLocalSocket();
  });
  localSocket.on("data", (chunk: Buffer) => {
    if (stream.cancelled) return;
    if (producerBusy) {
      failLocalSocket();
      return;
    }
    producerBusy = true;
    localSocket.pause();
    touchClientStream(stream, configuration.streamInactivityTimeoutMs);
    const sending = sendFlowControlledData(socket, outboundFlow, {
      generation,
      streamId,
      chunk,
    });
    pendingProducer = sending;
    void sending
      .then(() => {
        if (pendingProducer === sending) pendingProducer = undefined;
        producerBusy = false;
        if (!stream.cancelled && !localEnded) localSocket.resume();
      })
      .catch(failLocalSocket);
  });
  localSocket.once("end", () => {
    localEnded = true;
    void (pendingProducer ?? Promise.resolve()).then(async () => {
        if (stream.cancelled) return;
        stream.responseEnded = true;
        await sendCarrierFrame(socket, {
          type: FrameType.EndStream,
          generation,
          streamId,
        });
        maybeDeleteStream(
          streams,
          streamLifecycle,
          outboundFlow,
          inboundFlow,
          streamId,
          stream,
        );
      })
      .catch(failLocalSocket);
  });

  const activating = (async () => {
    await sendCarrierFrame(socket, {
      type: FrameType.ResponseHeaders,
      generation,
      streamId,
      payload: encodeMetadata({
        statusCode: response.statusCode ?? 101,
        statusMessage: response.statusMessage ?? "Switching Protocols",
        headers: projectResponseHeaders(rawHeadersToPairs(response.rawHeaders), {
          originProjection: configuration.originProjection,
          localOrigin: origin.origin,
          publicOrigin: configuration.publicOrigin,
          reservedCookieNames: RESERVED_GATEWAY_COOKIES,
        }),
      }),
    });
    if (head.byteLength > 0) {
      await sendFlowControlledData(socket, outboundFlow, {
        generation,
        streamId,
        chunk: head,
      });
    }
  })();
  pendingProducer = activating;
  try {
    await activating;
    if (pendingProducer === activating) pendingProducer = undefined;
    producerBusy = false;
    if (!stream.cancelled && !localEnded) localSocket.resume();
  } catch {
    failLocalSocket();
  }
}

async function forwardLocalResponse(
  socket: WebSocket,
  streams: Map<number, ClientStream>,
  streamLifecycle: RemoteStreamLifecycle,
  outboundFlow: OutboundFlowWindow,
  inboundFlow: InboundFlowWindow,
  generation: number,
  resetStream: ResetStreamSender,
  streamId: number,
  stream: ClientStream,
  response: IncomingMessage,
  origin: URL,
  configuration: SessionConfigSnapshot,
): Promise<void> {
  try {
    await sendCarrierFrame(socket, {
      type: FrameType.ResponseHeaders,
      generation,
      streamId,
      payload: encodeMetadata({
        statusCode: response.statusCode ?? 502,
        statusMessage: response.statusMessage ?? "",
        headers: projectResponseHeaders(
          sanitizeHopByHopHeaders(rawHeadersToPairs(response.rawHeaders)),
          {
            originProjection: configuration.originProjection,
            localOrigin: origin.origin,
            publicOrigin: configuration.publicOrigin,
            reservedCookieNames: RESERVED_GATEWAY_COOKIES,
          },
        ),
      }),
    });
    for await (const chunk of response) {
      if (stream.cancelled) return;
      touchClientStream(stream, configuration.streamInactivityTimeoutMs);
      await sendFlowControlledData(socket, outboundFlow, {
        generation,
        streamId,
        chunk,
      });
    }
    if (stream.cancelled) return;
    stream.responseEnded = true;
    await sendCarrierFrame(socket, {
      type: FrameType.EndStream,
      generation,
      streamId,
    });
    maybeDeleteStream(
      streams,
      streamLifecycle,
      outboundFlow,
      inboundFlow,
      streamId,
      stream,
    );
  } catch {
    if (stream.cancelled) return;
    cancelClientStream(
      streams,
      streamLifecycle,
      outboundFlow,
      inboundFlow,
      streamId,
      stream,
      "LOCAL_RESET",
    );
    resetStream(streamId, "LOCAL_RESPONSE_ERROR");
  }
}

function maybeDeleteStream(
  streams: Map<number, ClientStream>,
  streamLifecycle: RemoteStreamLifecycle,
  outboundFlow: OutboundFlowWindow,
  inboundFlow: InboundFlowWindow,
  streamId: number,
  stream: ClientStream,
): void {
  if (stream.requestEnded && stream.responseEnded) {
    clearClientStreamTimers(stream);
    streams.delete(streamId);
    streamLifecycle.close(streamId);
    outboundFlow.closeStream(streamId);
    inboundFlow.closeStream(streamId);
  }
}

function cancelClientStream(
  streams: Map<number, ClientStream>,
  streamLifecycle: RemoteStreamLifecycle,
  outboundFlow: OutboundFlowWindow,
  inboundFlow: InboundFlowWindow,
  streamId: number,
  stream: ClientStream,
  retirement: "LOCAL_RESET" | "REMOTE_RESET" = "REMOTE_RESET",
): void {
  if (stream.cancelled) return;
  stream.cancelled = true;
  clearClientStreamTimers(stream);
  streams.delete(streamId);
  streamLifecycle.close(streamId);
  outboundFlow.closeStream(streamId);
  if (retirement === "LOCAL_RESET") inboundFlow.retireStream(streamId);
  else inboundFlow.closeStream(streamId);
}

function enqueueInboundOperation(
  stream: ClientStream,
  operation: () => Promise<void>,
  applicationOperations: ApplicationOperationBudget,
  onProtocolError: (error: Error) => void,
): void {
  if (stream.pendingInboundOperations >= MAX_PENDING_STREAM_OPERATIONS) {
    throw new Error("too many pending operations for one stream");
  }
  const releaseApplicationOperation = applicationOperations.reserve();
  stream.pendingInboundOperations += 1;
  stream.inboundQueue = stream.inboundQueue
    .then(operation)
    .finally(() => {
      stream.pendingInboundOperations -= 1;
      releaseApplicationOperation();
    });
  void stream.inboundQueue.catch((error: unknown) => {
    if (!stream.cancelled) onProtocolError(toError(error));
  });
}

function armResponseHeaderTimer(stream: ClientStream, timeoutMs: number): void {
  if (
    stream.cancelled ||
    stream.response !== undefined ||
    stream.responseHeaderTimer !== undefined
  ) {
    return;
  }
  stream.responseHeaderTimer = setTimeout(
    () => stream.terminate?.("HEADER_TIMEOUT"),
    timeoutMs,
  );
  stream.responseHeaderTimer.unref();
}

function clearResponseHeaderTimer(stream: ClientStream): void {
  if (stream.responseHeaderTimer === undefined) return;
  clearTimeout(stream.responseHeaderTimer);
  delete stream.responseHeaderTimer;
}

function touchClientStream(stream: ClientStream, timeoutMs: number): void {
  if (stream.inactivityTimer !== undefined) {
    stream.inactivityTimer.refresh();
    return;
  }
  stream.inactivityTimer = setTimeout(
    () => stream.terminate?.("IDLE_TIMEOUT"),
    timeoutMs,
  );
  stream.inactivityTimer.unref();
}

function clearClientStreamTimers(stream: ClientStream): void {
  if (stream.responseHeaderTimer !== undefined) clearTimeout(stream.responseHeaderTimer);
  if (stream.inactivityTimer !== undefined) clearTimeout(stream.inactivityTimer);
  if (stream.durationTimer !== undefined) clearTimeout(stream.durationTimer);
  delete stream.responseHeaderTimer;
  delete stream.inactivityTimer;
  delete stream.durationTimer;
}

async function sendWindowUpdate(
  socket: WebSocket,
  generation: number,
  streamId: number,
  bytes: number,
): Promise<void> {
  await sendCarrierFrame(socket, {
    type: FrameType.WindowUpdate,
    generation,
    streamId,
    payload: encodeWindowUpdate(bytes),
  });
}

async function sendReset(
  socket: WebSocket,
  generation: number,
  streamId: number,
  code: string,
): Promise<void> {
  await sendCarrierFrame(socket, {
    type: FrameType.ResetStream,
    generation,
    streamId,
    payload: encodeMetadata({ code }),
  });
}

function parseLoopbackOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new TypeError("local origin must be a valid URL");
  }
  if (origin.username !== "" || origin.password !== "") {
    throw new TypeError("local origin must not include username or password credentials");
  }
  if (origin.protocol !== "http:") {
    throw new TypeError("Phase 1 local origin must use http");
  }
  if (!isLoopbackHost(origin.hostname)) {
    throw new TypeError("local origin must be loopback");
  }
  if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new TypeError("local origin must not include path, query, or fragment");
  }
  return origin;
}

function fingerprintLocalOrigin(origin: URL): string {
  return createHash("sha256")
    .update("review-tunnel.v1.local-origin\0", "utf8")
    .update(origin.origin, "utf8")
    .digest("base64url");
}

async function resolveAndProbeLocalOrigin(origin: URL): Promise<string> {
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) === 0
    ? (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address)
    : [hostname];
  if (addresses.length === 0 || addresses.some((address) => !isLoopbackAddress(address))) {
    throw new Error("local origin DNS must resolve exclusively to loopback addresses");
  }
  let lastError: unknown;
  for (const address of [...new Set(addresses)]) {
    try {
      await probeLocalOrigin(origin, address);
      return address;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("local origin is unavailable");
}

async function probePinnedLocalOrigin(origin: URL, address: string): Promise<string> {
  if (!isLoopbackAddress(address)) throw new Error("pinned local origin is not loopback");
  await probeLocalOrigin(origin, address);
  return address;
}

async function probeLocalOrigin(origin: URL, address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connectTcp({
      host: address,
      port: Number(origin.port || "80"),
    });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("local origin probe timed out"));
    }, 1_500);
    timeout.unref();
    const cleanup = () => clearTimeout(timeout);
    socket.once("connect", () => {
      cleanup();
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  const firstOctet = Number(address.split(".", 1)[0]);
  return firstOctet === 127;
}

export function hasValidWebSocketUpgrade(
  requestHeaders: readonly HeaderPair[],
  response: IncomingMessage,
): boolean {
  const keys = requestHeaders
    .filter(([name]) => name.toLowerCase() === "sec-websocket-key")
    .map(([, value]) => value.trim());
  const accepts = responseHeaderValues(response, "sec-websocket-accept");
  if (
    response.statusCode !== 101 ||
    keys.length !== 1 ||
    accepts.length !== 1 ||
    !headerHasToken(responseHeaderValues(response, "connection"), "upgrade") ||
    !headerIsSingleToken(responseHeaderValues(response, "upgrade"), "websocket")
  ) {
    return false;
  }
  const expected = createHash("sha1")
    .update(`${keys[0]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  if (accepts[0]?.trim() !== expected) return false;

  const offeredProtocols = commaSeparatedHeaderTokens(requestHeaders, "sec-websocket-protocol");
  const selectedProtocols = commaSeparatedValues(
    responseHeaderValues(response, "sec-websocket-protocol"),
  );
  if (
    selectedProtocols.length > 1 ||
    selectedProtocols.some((protocol) =>
      !isHttpToken(protocol) || !offeredProtocols.includes(protocol)
    )
  ) {
    return false;
  }

  return responseHeaderValues(response, "sec-websocket-extensions").length === 0;
}

function responseHeaderValues(response: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]?.toLowerCase() === name) {
      const value = response.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function headerHasToken(values: readonly string[], expected: string): boolean {
  return commaSeparatedValues(values).some((value) => value.toLowerCase() === expected);
}

function headerIsSingleToken(values: readonly string[], expected: string): boolean {
  const tokens = commaSeparatedValues(values);
  return tokens.length === 1 && tokens[0]?.toLowerCase() === expected;
}

function commaSeparatedHeaderTokens(
  headers: readonly HeaderPair[],
  name: string,
): string[] {
  return commaSeparatedValues(
    headers
      .filter(([headerName]) => headerName.toLowerCase() === name)
      .map(([, value]) => value),
  ).filter(isHttpToken);
}

function commaSeparatedValues(values: readonly string[]): string[] {
  return values.flatMap((value) => value.split(",").map((part) => part.trim()))
    .filter((value) => value !== "");
}

function isHttpToken(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function requireOutboundFlow(
  flow: OutboundFlowWindow | undefined,
): OutboundFlowWindow {
  if (flow === undefined) throw new Error("Session configuration is not applied");
  return flow;
}

function requireInboundFlow(
  flow: InboundFlowWindow | undefined,
): InboundFlowWindow {
  if (flow === undefined) throw new Error("Session inbound flow is unavailable");
  return flow;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function toLocalHeaders(
  headers: readonly HeaderPair[],
  origin: URL,
  configuration: SessionConfigSnapshot,
  kind: "HTTP" | "WEBSOCKET",
): Record<string, string | string[]> {
  const output = headerPairsToOutgoingHeaders(projectRequestHeaders(
    sanitizeHopByHopHeaders(headers),
    {
      originProjection: configuration.originProjection,
      localOrigin: origin.origin,
      publicOrigin: configuration.publicOrigin,
    },
  ).filter(([name]) =>
    kind !== "WEBSOCKET" || name.toLowerCase() !== "sec-websocket-extensions"
  ));
  if (kind === "WEBSOCKET") {
    output.connection = "Upgrade";
    output.upgrade = "websocket";
  }
  return output;
}

function asBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new RangeError(`${name} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

async function settleBeforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} deadline exceeded`);
  if (signal?.aborted === true) throw abortReason(signal, label);

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${label} deadline exceeded`))),
      remaining,
    );
    timer.unref();
    const onAbort = () => finish(() => reject(abortReason(signal, label)));
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortReason(signal: AbortSignal | undefined, label: string): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(`${label} aborted`);
}

async function closeSocketBeforeDeadline(
  socket: WebSocket,
  deadline: number,
): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const remaining = Math.max(0, deadline - Date.now());
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      resolve();
    };
    const onClose = () => finish();
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } finally {
        finish();
      }
    }, remaining);
    timer.unref();
    socket.once("close", onClose);
  });
}

function isTransientReconnectError(error: Error): boolean {
  if (error instanceof TunnelConnectionError) return error.code === "RESUME_IN_PROGRESS";
  return !/WebSocket code (?:1002|1008)\b/.test(error.message);
}
