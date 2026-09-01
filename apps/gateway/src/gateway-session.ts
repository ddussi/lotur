import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import {
  transitionSession,
  type ConfigAppliedMetadata,
  type SessionConfigMetadata,
  type SessionPolicy,
  type SessionState,
} from "../../../packages/protocol/src/index.ts";
import type { OutboundFlowWindow } from "../../../packages/relay/src/index.ts";
import type { GatewayStreamIds } from "./gateway-stream-ids.ts";
import type { GatewayInboundFlow } from "./inbound-flow.ts";
import type { GatewayMetrics } from "./metrics.ts";

export type GatewayTransportEpoch = Readonly<{
  socket: WebSocket;
  generation: number;
  outboundFlow: OutboundFlowWindow;
  inboundFlow: GatewayInboundFlow;
}>;

export type GatewayHttpStream = {
  readonly kind: "HTTP";
  readonly transport: GatewayTransportEpoch;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  requestEnded: boolean;
  // Receiving END and flushing queued writes to the response are separate steps.
  responseEnded: boolean;
  responseFinished: boolean;
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

export type GatewayWebSocketStream = {
  readonly kind: "WEBSOCKET";
  readonly transport: GatewayTransportEpoch;
  readonly browserSocket: Duplex;
  readonly pendingHead: Uint8Array;
  responseStarted: boolean;
  upgraded: boolean;
  browserEnded: boolean;
  // Keep the Stream until the queued socket.end() has run after all DATA writes.
  localEnded: boolean;
  localFinished: boolean;
  downstreamQueuedFrames: number;
  downstreamQueue: Promise<void>;
  cancelled: boolean;
  readonly reviewerAccountId?: string;
  readonly reviewerAuthVersion?: number;
  readonly reviewerAuthorizedAt?: number;
  durationTimer?: NodeJS.Timeout;
};

export type GatewayStream = GatewayHttpStream | GatewayWebSocketStream;

export type GatewaySession = {
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

export function captureGatewayTransport(session: GatewaySession): GatewayTransportEpoch {
  return {
    socket: session.socket,
    generation: session.generation,
    outboundFlow: session.outboundFlow,
    inboundFlow: session.inboundFlow,
  };
}

export function isCurrentGatewayTransport(
  session: GatewaySession,
  transport: GatewayTransportEpoch,
): boolean {
  return (
    session.socket === transport.socket &&
    session.generation === transport.generation &&
    session.outboundFlow === transport.outboundFlow &&
    session.inboundFlow === transport.inboundFlow
  );
}

export function isCurrentGatewaySessionTransport(
  sessions: ReadonlyMap<string, GatewaySession>,
  session: GatewaySession,
  transport: GatewayTransportEpoch,
): boolean {
  return (
    sessions.get(session.tunnelId) === session && isCurrentGatewayTransport(session, transport)
  );
}

export function isCurrentGatewayStream(
  session: GatewaySession,
  streamId: number,
  stream: GatewayStream,
): boolean {
  return (
    isCurrentGatewayTransport(session, stream.transport) && session.streams.get(streamId) === stream
  );
}

export function isCurrentGatewaySessionStream(
  sessions: ReadonlyMap<string, GatewaySession>,
  session: GatewaySession,
  streamId: number,
  stream: GatewayStream,
): boolean {
  return (
    sessions.get(session.tunnelId) === session && isCurrentGatewayStream(session, streamId, stream)
  );
}

export function removeGatewayStream(
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
    const nextLifecycle = transitionSession(
      session.lifecycle,
      {
        type: "STREAM_CLOSED",
        now: session.now(),
      },
      session.policy,
    );
    session.lifecycle = nextLifecycle;
    if (nextLifecycle.status === "EXPIRED") {
      session.disposeExpired(session, nextLifecycle.reason);
    }
  }
  return true;
}

export function beginGatewayStream(session: GatewaySession): boolean {
  const nextLifecycle = transitionSession(
    session.lifecycle,
    {
      type: "STREAM_OPEN",
      now: session.now(),
    },
    session.policy,
  );
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

export function clearRequestInactivityTimer(stream: GatewayHttpStream): void {
  if (stream.requestInactivityTimer === undefined) return;
  clearTimeout(stream.requestInactivityTimer);
  delete stream.requestInactivityTimer;
}

export function clearGatewayStreamTimers(stream: GatewayStream): void {
  if (stream.durationTimer !== undefined) clearTimeout(stream.durationTimer);
  delete stream.durationTimer;
  if (stream.kind === "HTTP") clearRequestInactivityTimer(stream);
}

export type GatewayEventSink = (
  event: string,
  session?: GatewaySession,
  details?: Readonly<{ streamId?: number; reason?: string }>,
) => void;

export function disposeActivationCandidate(session: GatewaySession): void {
  if (session.configAckTimer !== undefined) {
    clearTimeout(session.configAckTimer);
    delete session.configAckTimer;
  }
  delete session.probe;
  session.configSendCount = 0;
  session.outboundFlow.close();
}
