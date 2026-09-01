import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import type { Principal } from "../../../packages/auth/src/index.ts";
import {
  type decodeEnvelope,
  decodeWindowUpdate,
  decodeResetStreamMetadata,
  decodeResponseHeadersMetadata,
  encodeMetadata,
  encodeOpenHttpMetadata,
  encodeWindowUpdate,
  FrameType,
  MAX_HTTP_HEADER_PAIRS,
} from "../../../packages/protocol/src/index.ts";
import {
  headerPairsToOutgoingHeaders,
  isolateGatewayCredentials,
  rawHeadersToPairs,
  sanitizeHopByHopHeaders,
  stripUntrustedForwardingHeaders,
} from "../../../packages/proxy/src/index.ts";
import {
  INITIAL_STREAM_WINDOW_BYTES,
  sendCarrierFrame,
  sendFlowControlledData,
} from "../../../packages/relay/src/index.ts";
import type { GatewayInboundFlow } from "./inbound-flow.ts";
import {
  type GatewayTransportEpoch,
  type GatewayHttpStream,
  type GatewayWebSocketStream,
  type GatewaySession,
  captureGatewayTransport,
  isCurrentGatewayStream,
  isCurrentGatewaySessionStream,
  removeGatewayStream,
  beginGatewayStream,
  clearRequestInactivityTimer,
} from "./gateway-session.ts";
import { writeRawError, writeGatewayError } from "./gateway-responses.ts";

const MAX_PENDING_DOWNSTREAM_FRAMES = 1_024;

const RESERVED_GATEWAY_COOKIES = new Set([
  "__Host-rt_control",
  "__Host-rt_session",
  "rt_control_dev",
  "rt_session_dev",
]);

export async function handleReviewerRequest(
  sessions: ReadonlyMap<string, GatewaySession>,
  tunnelId: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  reviewer?: Principal,
): Promise<void> {
  if (request.destroyed || request.socket.destroyed || response.destroyed || response.writableEnded)
    return;
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

  const openRequest = prepareOpenRequest(request, "HTTP");
  if (!openRequest.ok) {
    writeGatewayError(response, openRequest.status, openRequest.code);
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
    responseFinished: false,
    responseBytes: 0,
    finiteResponse: false,
    responseBodyAllowed: false,
    downstreamQueuedFrames: 0,
    downstreamQueue: Promise.resolve(),
    cancelled: false,
    ...(reviewer === undefined
      ? {}
      : {
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
    if (stream.cancelled || !isCurrentGatewaySessionStream(sessions, session, streamId, stream))
      return;
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
      stream.responseFinished ||
      stream.cancelled ||
      !isCurrentGatewaySessionStream(sessions, session, streamId, stream)
    )
      return;
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
      payload: openRequest.payload,
    });

    let requestBytes = 0;
    for await (const chunk of request) {
      if (stream.cancelled || !isCurrentGatewaySessionStream(sessions, session, streamId, stream))
        return;
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
    if (stream.cancelled || !isCurrentGatewaySessionStream(sessions, session, streamId, stream))
      return;
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

export async function handleClientFrame(
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
    stream.transport.outboundFlow.update(envelope.streamId, decodeWindowUpdate(envelope.payload));
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
      stream.responseBodyAllowed = responseCanHaveBody(stream.request.method, metadata.statusCode);
      stream.finiteResponse =
        stream.responseBodyAllowed && isFiniteHttpResponse(metadata.headers, declaredResponseBytes);
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
        await sendReset(stream.transport, envelope.streamId, "UPSTREAM_RESPONSE_TOO_LARGE");
        return;
      }
      stream.response.writeHead(
        metadata.statusCode,
        metadata.statusMessage,
        headerPairsToOutgoingHeaders(
          isolateGatewayCredentials(
            sanitizeHopByHopHeaders(metadata.headers),
            RESERVED_GATEWAY_COOKIES,
          ),
        ),
      );
      break;
    }
    case FrameType.Data: {
      if (!stream.response.headersSent) throw new Error("DATA before response headers");
      if (stream.responseEnded) throw new Error("DATA after response END");
      if (!stream.responseBodyAllowed) throw new Error("DATA is forbidden for this response");
      const chunk = reserveInboundChunk(session, envelope.streamId, stream, envelope.payload);
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
        await sendReset(stream.transport, envelope.streamId, "UPSTREAM_RESPONSE_TOO_LARGE");
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

function isRetiredGatewayStream(session: GatewaySession, streamId: number): boolean {
  return (
    session.streamIds.wasIssued(streamId) &&
    !session.streams.has(streamId) &&
    session.probe?.streamId !== streamId
  );
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
      stream.responseFinished = true;
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
  if (!stream.requestEnded || !stream.responseFinished) return;
  if (removeGatewayStream(session, streamId, stream)) {
    stream.transport.outboundFlow.closeStream(streamId);
  }
}

function touchRequestInactivity(
  stream: GatewayHttpStream,
  timeoutMs: number,
  expire: (code: string) => void,
): void {
  if (stream.requestInactivityTimer !== undefined) {
    stream.requestInactivityTimer.refresh();
    return;
  }
  stream.requestInactivityTimer = setTimeout(() => expire("IDLE_TIMEOUT"), timeoutMs);
  stream.requestInactivityTimer.unref();
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

function contentLengthFromPairs(
  headers: readonly (readonly [string, string])[],
): number | undefined {
  const values = headers
    .filter(([name]) => name.toLowerCase() === "content-length")
    .map(([, value]) => parseContentLength(value));
  if (values.length !== 1) return undefined;
  return values[0];
}

function isFiniteHttpResponse(
  headers: readonly (readonly [string, string])[],
  declaredResponseBytes: number | undefined,
): boolean {
  const contentType = headers
    .find(([name]) => name.toLowerCase() === "content-type")?.[1]
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType === "text/event-stream") return false;
  return declaredResponseBytes !== undefined;
}

function responseCanHaveBody(method: string | undefined, statusCode: number): boolean {
  return (
    method !== "HEAD" &&
    !(statusCode >= 100 && statusCode < 200) &&
    statusCode !== 204 &&
    statusCode !== 304
  );
}

export async function handleReviewerUpgrade(
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
  )
    return;
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

  const openRequest = prepareOpenRequest(request, "WEBSOCKET");
  if (!openRequest.ok) {
    writeRawError(browserSocket, openRequest.status, openRequest.code);
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
    localFinished: false,
    downstreamQueuedFrames: 0,
    downstreamQueue: Promise.resolve(),
    cancelled: false,
    ...(reviewer === undefined
      ? {}
      : {
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
    if (stream.cancelled || !isCurrentGatewaySessionStream(sessions, session, streamId, stream))
      return;
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
    if (stream.cancelled || !isCurrentGatewaySessionStream(sessions, session, streamId, stream))
      return;
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
      payload: openRequest.payload,
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

function prepareOpenRequest(request: IncomingMessage, kind: "HTTP" | "WEBSOCKET") {
  const headers = isolateGatewayCredentials(
    sanitizeHopByHopHeaders(stripUntrustedForwardingHeaders(rawHeadersToPairs(request.rawHeaders))),
    RESERVED_GATEWAY_COOKIES,
  );
  try {
    const payload = encodeOpenHttpMetadata({
      kind,
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers,
      requestBodyEnded: kind === "WEBSOCKET",
      initialWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
    });
    return { ok: true, payload } as const;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return headers.length > MAX_HTTP_HEADER_PAIRS
      ? ({ ok: false, status: 431, code: "REQUEST_HEADERS_TOO_LARGE" } as const)
      : ({ ok: false, status: 400, code: "INVALID_REQUEST_METADATA" } as const);
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
            await sendFlowControlledData(stream.transport.socket, stream.transport.outboundFlow, {
              generation: stream.transport.generation,
              streamId,
              chunk: stream.pendingHead,
            });
          } catch {
            if (stream.cancelled || !isCurrentGatewayStream(session, streamId, stream)) return;
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
      if (stream.localEnded) throw new Error("DATA after WebSocket response END");
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
      stream.localFinished = true;
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
        return sendFlowControlledData(stream.transport.socket, stream.transport.outboundFlow, {
          generation: stream.transport.generation,
          streamId,
          chunk,
        });
      })
      .then(() => {
        if (
          !stream.cancelled &&
          !stream.browserEnded &&
          isCurrentGatewayStream(session, streamId, stream)
        )
          stream.browserSocket.resume();
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
        if (stream.localFinished) {
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

export async function sendWindowUpdate(
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

function serializeRawHeaders(metadata: ReturnType<typeof decodeResponseHeadersMetadata>): Buffer {
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

export async function sendReset(
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
