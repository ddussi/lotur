import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
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

type ClientStream = {
  readonly kind: "HTTP" | "WEBSOCKET";
  readonly request: ClientRequest;
  response?: IncomingMessage;
  localSocket?: Duplex;
  requestEnded: boolean;
  responseEnded: boolean;
  cancelled: boolean;
  responseHeaderTimer?: NodeJS.Timeout;
  inactivityTimer?: NodeJS.Timeout;
  durationTimer?: NodeJS.Timeout;
  terminate?: (code: string) => void;
};

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
  const originProjection = input.originProjection ?? "local-view";
  const localOriginFingerprint = fingerprintLocalOrigin(origin);
  const socket = new WebSocket(input.gatewayUrl, CARRIER_PROFILE, {
    perMessageDeflate: false,
    ...(input.carrierCredential === undefined ? {} : {
      headers: { authorization: `Bearer ${input.carrierCredential}` },
    }),
  });
  const streams = new Map<number, ClientStream>();
  let outboundFlow: OutboundFlowWindow | undefined;
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
  let activationCandidateSettled = false;
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

  let receiveQueue = Promise.resolve();
  socket.on("message", (data, isBinary) => {
    receiveQueue = receiveQueue
      .then(async () => {
        if (!isBinary) throw new Error("Carrier accepts binary frames only");
        const envelope = decodeEnvelope(asBytes(data));
        if (envelope.type === FrameType.Ping && envelope.streamId === 0) {
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
            probeStreamId = envelope.streamId;
            outboundFlow.openStream(envelope.streamId, probe.initialWindowBytes);
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
              await sendWindowUpdate(
                socket,
                generation,
                envelope.streamId,
                envelope.payload.byteLength,
              );
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
          if (probeStreamId !== undefined) outboundFlow?.closeStream(probeStreamId);
          readyResolve({
            ...activated,
            resumeSecret,
            pinnedLocalAddress: localConnectAddress,
          });
          return;
        }
        if (envelope.generation !== generation) {
          throw new Error("stale Carrier generation");
        }
        if (configured === undefined) throw new Error("active Session has no configuration");
        if (localConnectAddress === undefined) {
          throw new Error("active Session has no pinned local origin address");
        }
        await handleGatewayFrame(
          socket,
          streams,
          requireOutboundFlow(outboundFlow),
          origin,
          localConnectAddress,
          configured.snapshot,
          generation,
          envelope,
        );
      })
      .catch((error: unknown) => {
        failure ??= toError(error);
        if (!active) readyReject(failure);
        socket.close(1002, "protocol error");
      });
  });

  const fail = (error: Error) => {
    failure ??= error;
    if (!active) readyReject(error);
    settleActivationCandidate(undefined);
    if (resourcesClosed) return;
    resourcesClosed = true;
    for (const stream of streams.values()) {
      stream.cancelled = true;
      clearClientStreamTimers(stream);
      stream.request.destroy(error);
      stream.response?.destroy(error);
      stream.localSocket?.destroy(error);
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
      const closed = once(socket, "close").then(() => undefined);
      if (active && socket.readyState === WebSocket.OPEN) {
        await sendCarrierFrame(socket, {
          type: FrameType.CloseSession,
          generation,
          streamId: 0,
        });
      } else {
        socket.close(1000, "client closed");
      }
      await closed;
    },
    async disconnect() {
      if (socket.readyState === WebSocket.CLOSED) return;
      closeIntent = "disconnected";
      const closed = once(socket, "close").then(() => undefined);
      socket.terminate();
      await closed;
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
  connectionFactory?: (input: TunnelClientInput) => TunnelClient;
  issueCarrierCredential?: (
    purpose: "resume",
    tunnelId: string,
  ) => Promise<string>;
  onStatus?: (status: Readonly<{
    state: "reconnecting" | "active" | "failed";
    attempt?: number;
    error?: Error;
  }>) => void;
}>): TunnelClient {
  const reconnectGraceMs = input.reconnectGraceMs ?? 2 * 60_000;
  const connectionFactory = input.connectionFactory ?? connectTunnelClient;
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
    await delay(Math.min(50, reconnectGraceMs));
    while (!stopped && Date.now() < deadline) {
      attempt += 1;
      input.onStatus?.({ state: "reconnecting", attempt, error: lastError });
      let candidate: TunnelClient | undefined;
      try {
        const credential = await input.issueCarrierCredential?.("resume", input.tunnelId);
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
        });
        current = candidate;
        const resumed = await candidate.ready;
        input.onStatus?.({ state: "active", attempt });
        return resumed;
      } catch (error) {
        await candidate?.closed;
        lastError = toError(error);
        if (!isTransientReconnectError(lastError)) break;
        const requestedDelay = lastError instanceof TunnelConnectionError
          ? lastError.retryAfterMs
          : undefined;
        const exponentialDelay = Math.min(2_000, 100 * 2 ** Math.min(attempt - 1, 4));
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(remaining, requestedDelay ?? exponentialDelay));
      }
    }
    throw lastError;
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
      await current.close();
      settleClosure({ reason: "closed" });
    },
    async disconnect() {
      await current.disconnect();
    },
  };
}

async function handleGatewayFrame(
  socket: WebSocket,
  streams: Map<number, ClientStream>,
  outboundFlow: OutboundFlowWindow,
  origin: URL,
  localConnectAddress: string,
  configuration: SessionConfigSnapshot,
  generation: number,
  envelope: ReturnType<typeof decodeEnvelope>,
): Promise<void> {
  if (envelope.type === FrameType.OpenHttp) {
    if (streams.has(envelope.streamId)) throw new Error("duplicate stream ID");
    const metadata = decodeOpenHttpMetadata(envelope.payload);
    outboundFlow.openStream(envelope.streamId, metadata.initialWindowBytes);
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
      responseEnded: false,
      cancelled: false,
    };
    streams.set(envelope.streamId, stream);
    const terminate = (code: string) => {
      if (stream.cancelled) return;
      stream.cancelled = true;
      clearClientStreamTimers(stream);
      streams.delete(envelope.streamId);
      outboundFlow.closeStream(envelope.streamId);
      const error = new Error(code);
      stream.request.destroy(error);
      stream.response?.destroy(error);
      stream.localSocket?.destroy(error);
      void sendReset(socket, generation, envelope.streamId, code);
    };
    stream.terminate = terminate;
    stream.responseHeaderTimer = setTimeout(
      () => terminate("HEADER_TIMEOUT"),
      configuration.responseHeaderTimeoutMs,
    );
    stream.responseHeaderTimer.unref();
    stream.durationTimer = setTimeout(
      () => terminate("LIMIT_EXCEEDED"),
      configuration.maxStreamDurationMs,
    );
    stream.durationTimer.unref();

    if (metadata.kind === "WEBSOCKET") {
      localRequest.once("upgrade", (response, localSocket, head) => {
        if (!hasValidWebSocketAccept(metadata.headers, response)) {
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
          outboundFlow,
          generation,
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
        outboundFlow,
        generation,
        envelope.streamId,
        stream,
        response,
        origin,
        configuration,
      );
    });
    localRequest.once("error", () => {
      if (stream.cancelled) return;
      stream.cancelled = true;
      clearClientStreamTimers(stream);
      streams.delete(envelope.streamId);
      outboundFlow.closeStream(envelope.streamId);
      void sendReset(socket, generation, envelope.streamId, "LOCAL_ORIGIN_ERROR");
    });
    if (metadata.requestBodyEnded) localRequest.end();
    return;
  }

  const stream = streams.get(envelope.streamId);
  if (stream === undefined || stream.cancelled) return;
  if (envelope.type === FrameType.WindowUpdate) {
    outboundFlow.update(envelope.streamId, decodeWindowUpdate(envelope.payload));
    return;
  }
  if (envelope.type === FrameType.Data) {
    touchClientStream(stream, configuration.streamInactivityTimeoutMs);
  }

  switch (envelope.type) {
    case FrameType.Data:
      if (stream.kind === "WEBSOCKET" && stream.localSocket !== undefined) {
        if (!stream.localSocket.write(envelope.payload)) {
          socket.pause();
          await once(stream.localSocket, "drain");
          socket.resume();
        }
        await sendWindowUpdate(
          socket,
          generation,
          envelope.streamId,
          envelope.payload.byteLength,
        );
        break;
      }
      if (stream.requestEnded) throw new Error("request DATA after END");
      if (!stream.request.write(envelope.payload)) {
        socket.pause();
        await once(stream.request, "drain");
        socket.resume();
      }
      await sendWindowUpdate(
        socket,
        generation,
        envelope.streamId,
        envelope.payload.byteLength,
      );
      break;
    case FrameType.EndStream:
      if (stream.kind === "WEBSOCKET" && stream.localSocket !== undefined) {
        if (stream.requestEnded) throw new Error("duplicate raw END");
        stream.requestEnded = true;
        stream.localSocket.end();
        maybeDeleteStream(streams, outboundFlow, envelope.streamId, stream);
        break;
      }
      if (stream.requestEnded) throw new Error("duplicate request END");
      stream.requestEnded = true;
      stream.request.end();
      maybeDeleteStream(streams, outboundFlow, envelope.streamId, stream);
      break;
    case FrameType.ResetStream: {
      const reset = decodeResetStreamMetadata(envelope.payload);
      stream.cancelled = true;
      clearClientStreamTimers(stream);
      streams.delete(envelope.streamId);
      outboundFlow.closeStream(envelope.streamId);
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

async function activateLocalWebSocket(
  socket: WebSocket,
  streams: Map<number, ClientStream>,
  outboundFlow: OutboundFlowWindow,
  generation: number,
  streamId: number,
  stream: ClientStream,
  response: IncomingMessage,
  localSocket: Duplex,
  head: Buffer,
  origin: URL,
  configuration: SessionConfigSnapshot,
): Promise<void> {
  localSocket.pause();
  try {
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

    let sendQueue = Promise.resolve();
    localSocket.on("data", (chunk: Buffer) => {
      touchClientStream(stream, configuration.streamInactivityTimeoutMs);
      sendQueue = sendQueue
        .then(() =>
          sendFlowControlledData(socket, outboundFlow, {
            generation,
            streamId,
            chunk,
          }),
        )
        .catch(() => {
          stream.cancelled = true;
          clearClientStreamTimers(stream);
          streams.delete(streamId);
          outboundFlow.closeStream(streamId);
          localSocket.destroy();
        });
    });
    localSocket.once("end", () => {
      sendQueue = sendQueue
        .then(async () => {
          stream.responseEnded = true;
          await sendCarrierFrame(socket, {
            type: FrameType.EndStream,
            generation,
            streamId,
          });
          maybeDeleteStream(streams, outboundFlow, streamId, stream);
        })
        .catch(() => undefined);
    });
    localSocket.once("error", () => {
      if (stream.cancelled) return;
      stream.cancelled = true;
      clearClientStreamTimers(stream);
      streams.delete(streamId);
      outboundFlow.closeStream(streamId);
      void sendReset(socket, generation, streamId, "LOCAL_IO_ERROR");
    });
    stream.requestEnded = false;
    localSocket.resume();
  } catch {
    stream.cancelled = true;
    clearClientStreamTimers(stream);
    streams.delete(streamId);
    outboundFlow.closeStream(streamId);
    localSocket.destroy();
    await sendReset(socket, generation, streamId, "LOCAL_IO_ERROR");
  }
}

async function forwardLocalResponse(
  socket: WebSocket,
  streams: Map<number, ClientStream>,
  outboundFlow: OutboundFlowWindow,
  generation: number,
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
    maybeDeleteStream(streams, outboundFlow, streamId, stream);
  } catch {
    if (stream.cancelled) return;
    stream.cancelled = true;
    clearClientStreamTimers(stream);
    streams.delete(streamId);
    outboundFlow.closeStream(streamId);
    await sendReset(socket, generation, streamId, "LOCAL_RESPONSE_ERROR");
  }
}

function maybeDeleteStream(
  streams: Map<number, ClientStream>,
  outboundFlow: OutboundFlowWindow,
  streamId: number,
  stream: ClientStream,
): void {
  if (stream.requestEnded && stream.responseEnded) {
    clearClientStreamTimers(stream);
    streams.delete(streamId);
    outboundFlow.closeStream(streamId);
  }
}

function clearResponseHeaderTimer(stream: ClientStream): void {
  if (stream.responseHeaderTimer === undefined) return;
  clearTimeout(stream.responseHeaderTimer);
  delete stream.responseHeaderTimer;
}

function touchClientStream(stream: ClientStream, timeoutMs: number): void {
  if (stream.inactivityTimer !== undefined) clearTimeout(stream.inactivityTimer);
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
  if (socket.readyState !== WebSocket.OPEN) return;
  await sendCarrierFrame(socket, {
    type: FrameType.ResetStream,
    generation,
    streamId,
    payload: encodeMetadata({ code }),
  }).catch(() => undefined);
}

function parseLoopbackOrigin(value: string): URL {
  const origin = new URL(value);
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

function hasValidWebSocketAccept(
  requestHeaders: readonly HeaderPair[],
  response: IncomingMessage,
): boolean {
  const keys = requestHeaders
    .filter(([name]) => name.toLowerCase() === "sec-websocket-key")
    .map(([, value]) => value.trim());
  const accept = response.headers["sec-websocket-accept"];
  if (keys.length !== 1 || typeof accept !== "string") return false;
  const expected = createHash("sha1")
    .update(`${keys[0]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  return accept.trim() === expected;
}

function requireOutboundFlow(
  flow: OutboundFlowWindow | undefined,
): OutboundFlowWindow {
  if (flow === undefined) throw new Error("Session configuration is not applied");
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

function isTransientReconnectError(error: Error): boolean {
  if (error instanceof TunnelConnectionError) return error.code === "RESUME_IN_PROGRESS";
  return !/WebSocket code (?:1002|1008)\b/.test(error.message);
}
