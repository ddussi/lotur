import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type {
  AuthService,
  DeveloperAuthorization,
  Principal,
} from "../../../packages/auth/src/index.ts";

import {
  decodeEnvelope,
  decodeHelloMetadata,
  decodeWindowUpdate,
  decodeResetStreamMetadata,
  decodeResponseHeadersMetadata,
  encodeMetadata,
  encodeWindowUpdate,
  FrameType,
  isResumeAllowed,
} from "../../../packages/protocol/src/index.ts";
import {
  headerPairsToOutgoingHeaders,
  isolateGatewayCredentials,
  rawHeadersToPairs,
  sanitizeHopByHopHeaders,
} from "../../../packages/proxy/src/index.ts";
import {
  INITIAL_CONNECTION_WINDOW_BYTES,
  INITIAL_STREAM_WINDOW_BYTES,
  OutboundFlowWindow,
  sendCarrierFrame,
  sendFlowControlledData,
} from "../../../packages/relay/src/index.ts";
import { createWebAuthHandler } from "./web-auth.ts";

const CARRIER_PATH = "/_review-tunnel/carrier";
const CARRIER_PROFILE = "review-tunnel.poc.1";
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
  cancelled: boolean;
  readonly reviewerAccountId?: string;
  readonly reviewerAuthVersion?: number;
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
};

type GatewayStream = GatewayHttpStream | GatewayWebSocketStream;

type GatewaySession = {
  readonly tunnelId: string;
  socket: WebSocket;
  readonly streams: Map<number, GatewayStream>;
  outboundFlow: OutboundFlowWindow;
  generation: number;
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
}>;

export type GatewayServerOptions = Readonly<{
  host?: string;
  port?: number;
  contentDomain?: string;
  controlHost?: string;
  authService?: AuthService;
  secureCookies?: boolean;
  authorizationCheckIntervalMs?: number;
}>;

export function createGatewayServer(
  options: GatewayServerOptions = {},
): GatewayServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const contentDomain = options.contentDomain ?? "localhost";
  const webAuth = options.authService === undefined ? undefined : createWebAuthHandler({
    authService: options.authService,
    controlHost: options.controlHost ?? `control.${contentDomain}`,
    secureCookies: options.secureCookies ?? true,
  });
  const controlHostname = hostnameOf(options.controlHost ?? `control.${contentDomain}`);
  const resumeHmacKey = randomBytes(32);
  const sessions = new Map<string, GatewaySession>();
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
        if (webAuth !== undefined && hostnameOf(request.headers.host) === controlHostname) {
          await webAuth.handleControl(request, response);
          return;
        }
        if (webAuth !== undefined) {
          const tunnelId = getTunnelId(request.headers.host, contentDomain);
          const session = tunnelId === undefined ? undefined : sessions.get(tunnelId);
          if (session === undefined || session.socket.readyState !== WebSocket.OPEN) {
            writeGatewayError(response, 503, "TUNNEL_OFFLINE");
            return;
          }
          reviewer = await webAuth.authorizeContent(request, response);
          if (reviewer === undefined) return;
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
    if (url.pathname !== CARRIER_PATH) {
      void (async () => {
        let reviewer: Principal | undefined;
        if (webAuth !== undefined) {
          const tunnelId = getTunnelId(request.headers.host, contentDomain);
          const session = tunnelId === undefined ? undefined : sessions.get(tunnelId);
          if (session === undefined || session.socket.readyState !== WebSocket.OPEN) {
            writeRawError(socket, 503, "TUNNEL_OFFLINE");
            return;
          }
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

  carriers.on("connection", (socket) => {
    const developerAuthorization = carrierAuthorizations.get(socket);
    let session: GatewaySession | undefined;
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
            let resumeSecret: string;
            if (hello.mode === "create") {
              if (sessions.has(hello.tunnelId)) {
                socket.close(1008, "tunnel ID already active");
                return;
              }
              resumeSecret = randomBytes(32).toString("base64url");
              session = {
                tunnelId: hello.tunnelId,
                socket,
                streams: new Map(),
                outboundFlow: new OutboundFlowWindow(
                  INITIAL_CONNECTION_WINDOW_BYTES,
                ),
                generation: 1,
                resumeDigest: digestResumeSecret(resumeHmacKey, resumeSecret),
                terminal: false,
                nextStreamId: 1,
                ...(developerAuthorization === undefined ? {} : {
                  ownerAccountId: developerAuthorization.accountId,
                  ownerAuthVersion: developerAuthorization.accountAuthVersion,
                }),
              };
              sessions.set(hello.tunnelId, session);
            } else {
              const existing = sessions.get(hello.tunnelId);
              if (
                existing === undefined ||
                existing.disconnectedAt === undefined ||
                !isResumeAllowed(Date.now(), existing.disconnectedAt) ||
                !resumeSecretMatches(
                  resumeHmacKey,
                  hello.resumeSecret,
                  existing.resumeDigest,
                )
              ) {
                socket.close(1008, "resume rejected");
                return;
              }
              if (existing.socket.readyState === WebSocket.OPEN) {
                socket.close(1008, "resume already active");
                return;
              }
              if (
                developerAuthorization !== undefined &&
                existing.ownerAccountId !== developerAuthorization.accountId
              ) {
                socket.close(1008, "resume owner mismatch");
                return;
              }
              if (existing.expiryTimer !== undefined) clearTimeout(existing.expiryTimer);
              delete existing.expiryTimer;
              delete existing.disconnectedAt;
              existing.socket = socket;
              existing.outboundFlow = new OutboundFlowWindow(
                INITIAL_CONNECTION_WINDOW_BYTES,
              );
              existing.generation += 1;
              existing.nextStreamId = 1;
              session = existing;
              resumeSecret = hello.resumeSecret;
            }
            await sendCarrierFrame(socket, {
              type: FrameType.SessionActive,
              generation: session.generation,
              streamId: 0,
              payload: encodeMetadata({
                generation: session.generation,
                resumeSecret,
              }),
            });
            clearTimeout(helloTimer);
            return;
          }
          if (envelope.generation !== session.generation) {
            throw new Error("stale Carrier generation");
          }
          if (envelope.type === FrameType.CloseSession && envelope.streamId === 0) {
            session.terminal = true;
            socket.close(1000, "session closed");
            return;
          }
          await handleClientFrame(session, envelope);
        })
        .catch(() => socket.close(1002, "protocol error"));
    });

    const cleanup = () => {
      clearTimeout(helloTimer);
      if (
        session === undefined ||
        sessions.get(session.tunnelId) !== session ||
        session.socket !== socket
      ) return;
      const current = session;
      current.outboundFlow.close();
      for (const stream of current.streams.values()) {
        stream.cancelled = true;
        if (stream.kind === "HTTP" && !stream.response.headersSent) {
          writeGatewayError(stream.response, 503, "TUNNEL_OFFLINE");
        } else if (stream.kind === "HTTP") {
          stream.response.destroy();
        } else {
          stream.browserSocket.destroy();
        }
      }
      current.streams.clear();
      if (current.terminal) {
        sessions.delete(current.tunnelId);
        return;
      }
      current.disconnectedAt = Date.now();
      current.expiryTimer = setTimeout(() => {
        if (
          sessions.get(current.tunnelId) === current &&
          current.disconnectedAt !== undefined &&
          !isResumeAllowed(Date.now(), current.disconnectedAt)
        ) {
          sessions.delete(current.tunnelId);
        }
      }, 2 * 60_000 + 10);
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
            session.streams.delete(streamId);
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
      for (const session of sessions.values()) {
        if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
        session.outboundFlow.close();
      }
      sessions.clear();
      for (const socket of carriers.clients) socket.terminate();
      await closeHttpServer(server);
      await new Promise<void>((resolve) => carriers.close(() => resolve()));
    },
  };
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
  if (session === undefined || session.socket.readyState !== WebSocket.OPEN) {
    writeGatewayError(response, 503, "TUNNEL_OFFLINE");
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
    cancelled: false,
    ...(reviewer === undefined ? {} : {
      reviewerAccountId: reviewer.accountId,
      reviewerAuthVersion: reviewer.authVersion,
    }),
  };
  session.streams.set(streamId, stream);
  session.outboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);

  response.once("close", () => {
    if (stream.responseEnded || stream.cancelled) return;
    stream.cancelled = true;
    session.streams.delete(streamId);
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
          sanitizeHopByHopHeaders(rawHeadersToPairs(request.rawHeaders)),
          RESERVED_GATEWAY_COOKIES,
        ),
        requestBodyEnded: false,
        initialWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
      }),
    });

    for await (const chunk of request) {
      if (stream.cancelled) return;
      await sendFlowControlledData(session.socket, session.outboundFlow, {
        generation: session.generation,
        streamId,
        chunk,
      });
    }
    if (stream.cancelled) return;
    stream.requestEnded = true;
    await sendCarrierFrame(session.socket, {
      type: FrameType.EndStream,
      generation: session.generation,
      streamId,
    });
    maybeDeleteStream(session, streamId, stream);
  } catch {
    stream.cancelled = true;
    session.streams.delete(streamId);
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
  if (envelope.type === FrameType.WindowUpdate) {
    session.outboundFlow.update(
      envelope.streamId,
      decodeWindowUpdate(envelope.payload),
    );
    return;
  }
  const stream = session.streams.get(envelope.streamId);
  if (stream === undefined || stream.cancelled) return;

  if (stream.kind === "WEBSOCKET") {
    await handleWebSocketClientFrame(session, envelope.streamId, stream, envelope);
    return;
  }

  switch (envelope.type) {
    case FrameType.ResponseHeaders: {
      if (stream.response.headersSent) throw new Error("duplicate response headers");
      const metadata = decodeResponseHeadersMetadata(envelope.payload);
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
      session.streams.delete(envelope.streamId);
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
  if (stream.requestEnded && stream.responseEnded) session.streams.delete(streamId);
  if (stream.requestEnded && stream.responseEnded) session.outboundFlow.closeStream(streamId);
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
  if (session === undefined || session.socket.readyState !== WebSocket.OPEN) {
    writeRawError(browserSocket, 503, "TUNNEL_OFFLINE");
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
    }),
  };
  session.streams.set(streamId, stream);
  session.outboundFlow.openStream(streamId, INITIAL_STREAM_WINDOW_BYTES);

  const cancel = () => {
    if (stream.cancelled || (stream.upgraded && stream.browserEnded)) return;
    stream.cancelled = true;
    session.streams.delete(streamId);
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
          sanitizeHopByHopHeaders(rawHeadersToPairs(request.rawHeaders)),
          RESERVED_GATEWAY_COOKIES,
        ),
        requestBodyEnded: true,
        initialWindowBytes: INITIAL_STREAM_WINDOW_BYTES,
      }),
    });
  } catch {
    stream.cancelled = true;
    session.streams.delete(streamId);
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
        session.streams.delete(streamId);
        session.outboundFlow.closeStream(streamId);
      }
      break;
    case FrameType.ResetStream: {
      stream.cancelled = true;
      session.streams.delete(streamId);
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
        session.streams.delete(streamId);
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
          session.streams.delete(streamId);
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
