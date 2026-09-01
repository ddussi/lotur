import { WebSocket } from "ws";
import type { SessionState } from "../../../packages/protocol/src/index.ts";
import {
  type GatewaySession,
  type GatewayEventSink,
  disposeActivationCandidate,
  clearGatewayStreamTimers,
} from "./gateway-session.ts";
import type { GatewayMetrics } from "./metrics.ts";
import { writeGatewayError } from "./gateway-responses.ts";

/** Owns session registration, terminal cleanup and pending disposal effects.
 * Transport adapters may update a current session; only this owner removes it.
 */
export function createGatewaySessions(
  input: Readonly<{
    metrics: GatewayMetrics;
    emit: GatewayEventSink;
    onDisposed?(session: GatewaySession): Promise<void>;
  }>,
) {
  const { metrics, emit, onDisposed } = input;
  const sessions = new Map<string, GatewaySession>();
  const pendingReviewCleanup = new Set<Promise<void>>();
  return {
    sessions: sessions as ReadonlyMap<string, GatewaySession>,
    register(session: GatewaySession): void {
      sessions.set(session.tunnelId, session);
    },
    remove(session: GatewaySession): void {
      if (sessions.get(session.tunnelId) === session) sessions.delete(session.tunnelId);
    },
    expireGatewaySession,
    terminateGatewaySession,
    disposeGatewaySession,
    disposeReviewBinding,
    applySessionTransition,
    closeGatewayStreams,
    async waitForCleanup(): Promise<void> {
      await Promise.all(pendingReviewCleanup);
    },
  };

  function expireGatewaySession(session: GatewaySession, reason: string): void {
    if (!disposeGatewaySession(session, "TUNNEL_EXPIRED")) return;
    metrics.increment("tunnel_expired");
    emit("tunnel.expired", session, { reason });
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.close(1008, "session expired");
    }
  }

  function terminateGatewaySession(
    session: GatewaySession,
    reason: string,
    closeCode = 1008,
  ): void {
    if (!disposeGatewaySession(session, "TUNNEL_OFFLINE")) return;
    metrics.increment("tunnel_closed");
    emit("tunnel.closed", session, { reason });
    if (session.socket.readyState === WebSocket.OPEN) session.socket.close(closeCode, reason);
  }

  function disposeGatewaySession(session: GatewaySession, responseCode: string): boolean {
    if (sessions.get(session.tunnelId) !== session) return false;
    session.terminal = true;
    if (session.expiryTimer !== undefined) {
      clearTimeout(session.expiryTimer);
      delete session.expiryTimer;
    }
    disposeActivationCandidate(session);
    closeGatewayStreams(session, responseCode);
    session.outboundFlow.close();
    disposeReviewBinding(session);
    sessions.delete(session.tunnelId);
    return true;
  }

  function closeGatewayStreams(session: GatewaySession, responseCode: string): void {
    for (const [streamId, stream] of session.streams) {
      stream.cancelled = true;
      stream.transport.inboundFlow.closeStream(streamId);
      stream.transport.outboundFlow.closeStream(streamId);
      clearGatewayStreamTimers(stream);
      if (stream.kind === "HTTP") {
        if (!stream.response.headersSent) {
          writeGatewayError(stream.response, 503, responseCode);
        } else {
          stream.response.destroy();
        }
        stream.request.destroy();
      } else {
        stream.browserSocket.destroy();
      }
    }
    session.streams.clear();
  }

  function disposeReviewBinding(session: GatewaySession): void {
    if (onDisposed === undefined) return;
    const cleanup = onDisposed(session).finally(() => {
      pendingReviewCleanup.delete(cleanup);
    });
    pendingReviewCleanup.add(cleanup);
  }

  function applySessionTransition(session: GatewaySession, nextLifecycle: SessionState): boolean {
    session.lifecycle = nextLifecycle;
    if (nextLifecycle.status !== "EXPIRED") return true;
    expireGatewaySession(session, nextLifecycle.reason);
    return false;
  }
}
