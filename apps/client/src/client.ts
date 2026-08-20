import { once } from "node:events";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, type RawData } from "ws";

import {
  decodeEnvelope,
  decodeOpenHttpMetadata,
  decodeResetStreamMetadata,
  decodeSessionActiveMetadata,
  decodeWindowUpdate,
  encodeMetadata,
  encodeWindowUpdate,
  FrameType,
  type HeaderPair,
} from "../../../packages/protocol/src/index.ts";
import {
  headerPairsToOutgoingHeaders,
  rawHeadersToPairs,
  sanitizeHopByHopHeaders,
} from "../../../packages/proxy/src/index.ts";
import {
  INITIAL_CONNECTION_WINDOW_BYTES,
  OutboundFlowWindow,
  sendCarrierFrame,
  sendFlowControlledData,
} from "../../../packages/relay/src/index.ts";

const CARRIER_PROFILE = "review-tunnel.poc.1";

type ClientStream = {
  readonly kind: "HTTP" | "WEBSOCKET";
  readonly request: ClientRequest;
  response?: IncomingMessage;
  localSocket?: Duplex;
  requestEnded: boolean;
  responseEnded: boolean;
  cancelled: boolean;
};

export type TunnelClient = Readonly<{
  ready: Promise<Readonly<{ generation: number; resumeSecret: string }>>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
}>;

export function connectTunnelClient(input: Readonly<{
  gatewayUrl: string;
  tunnelId: string;
  localOrigin: string;
  resumeSecret?: string;
  carrierCredential?: string;
}>): TunnelClient {
  const origin = parseLoopbackOrigin(input.localOrigin);
  const socket = new WebSocket(input.gatewayUrl, CARRIER_PROFILE, {
    perMessageDeflate: false,
    ...(input.carrierCredential === undefined ? {} : {
      headers: { authorization: `Bearer ${input.carrierCredential}` },
    }),
  });
  const streams = new Map<number, ClientStream>();
  const outboundFlow = new OutboundFlowWindow(INITIAL_CONNECTION_WINDOW_BYTES);
  let readyResolve!: (value: Readonly<{
    generation: number;
    resumeSecret: string;
  }>) => void;
  let readyReject!: (error: Error) => void;
  let active = false;
  let generation = 0;
  const ready = new Promise<Readonly<{
    generation: number;
    resumeSecret: string;
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
          ? { mode: "create", tunnelId: input.tunnelId }
          : {
              mode: "resume",
              tunnelId: input.tunnelId,
              resumeSecret: input.resumeSecret,
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
        if (!active) {
          if (
            envelope.type !== FrameType.SessionActive ||
            envelope.streamId !== 0
          ) {
            throw new Error("SESSION_ACTIVE must follow HELLO");
          }
          const activated = decodeSessionActiveMetadata(envelope.payload);
          if (envelope.generation !== activated.generation) {
            throw new Error("SESSION_ACTIVE generation mismatch");
          }
          generation = activated.generation;
          active = true;
          readyResolve(activated);
          return;
        }
        if (envelope.generation !== generation) {
          throw new Error("stale Carrier generation");
        }
        await handleGatewayFrame(
          socket,
          streams,
          outboundFlow,
          origin,
          generation,
          envelope,
        );
      })
      .catch((error: unknown) => {
        if (!active) readyReject(toError(error));
        socket.close(1002, "protocol error");
      });
  });

  const fail = (error: Error) => {
    if (!active) readyReject(error);
    for (const stream of streams.values()) {
      stream.cancelled = true;
      stream.request.destroy(error);
      stream.response?.destroy(error);
      stream.localSocket?.destroy(error);
    }
    streams.clear();
    outboundFlow.close();
  };
  socket.once("error", fail);
  socket.once("close", () => fail(new Error("Carrier closed")));

  return {
    ready,
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
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
      const closed = once(socket, "close").then(() => undefined);
      socket.terminate();
      await closed;
    },
  };
}

async function handleGatewayFrame(
  socket: WebSocket,
  streams: Map<number, ClientStream>,
  outboundFlow: OutboundFlowWindow,
  origin: URL,
  generation: number,
  envelope: ReturnType<typeof decodeEnvelope>,
): Promise<void> {
  if (envelope.type === FrameType.OpenHttp) {
    if (streams.has(envelope.streamId)) throw new Error("duplicate stream ID");
    const metadata = decodeOpenHttpMetadata(envelope.payload);
    outboundFlow.openStream(envelope.streamId, metadata.initialWindowBytes);
    const localRequest = request({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method: metadata.method,
      path: metadata.path,
      headers: toLocalHeaders(metadata.headers, origin, metadata.kind),
    });
    const stream: ClientStream = {
      kind: metadata.kind,
      request: localRequest,
      requestEnded: metadata.requestBodyEnded,
      responseEnded: false,
      cancelled: false,
    };
    streams.set(envelope.streamId, stream);

    if (metadata.kind === "WEBSOCKET") {
      localRequest.once("upgrade", (response, localSocket, head) => {
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
        );
      });
    }
    localRequest.once("response", (response) => {
      stream.response = response;
      void forwardLocalResponse(
        socket,
        streams,
        outboundFlow,
        generation,
        envelope.streamId,
        stream,
        response,
      );
    });
    localRequest.once("error", () => {
      if (stream.cancelled) return;
      stream.cancelled = true;
      streams.delete(envelope.streamId);
      outboundFlow.closeStream(envelope.streamId);
      void sendReset(socket, generation, envelope.streamId, "LOCAL_ORIGIN_ERROR");
    });
    if (metadata.requestBodyEnded) localRequest.end();
    return;
  }

  if (envelope.type === FrameType.WindowUpdate) {
    outboundFlow.update(envelope.streamId, decodeWindowUpdate(envelope.payload));
    return;
  }

  const stream = streams.get(envelope.streamId);
  if (stream === undefined || stream.cancelled) return;

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
        headers: rawHeadersToPairs(response.rawHeaders),
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
      streams.delete(streamId);
      outboundFlow.closeStream(streamId);
      void sendReset(socket, generation, streamId, "LOCAL_IO_ERROR");
    });
    stream.requestEnded = false;
    localSocket.resume();
  } catch {
    stream.cancelled = true;
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
): Promise<void> {
  try {
    await sendCarrierFrame(socket, {
      type: FrameType.ResponseHeaders,
      generation,
      streamId,
      payload: encodeMetadata({
        statusCode: response.statusCode ?? 502,
        statusMessage: response.statusMessage ?? "",
        headers: sanitizeHopByHopHeaders(rawHeadersToPairs(response.rawHeaders)),
      }),
    });
    for await (const chunk of response) {
      if (stream.cancelled) return;
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
    streams.delete(streamId);
    outboundFlow.closeStream(streamId);
  }
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
  kind: "HTTP" | "WEBSOCKET",
): Record<string, string | string[]> {
  const output = headerPairsToOutgoingHeaders(sanitizeHopByHopHeaders(headers));
  output.host = origin.host;
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
