import {
  type GatewaySession,
  captureGatewayTransport,
  isCurrentGatewaySessionTransport,
  removeGatewayStream,
} from "./gateway-session.ts";
import { sendReset } from "./gateway-streams.ts";
import { withPromiseDeadline, toSafeErrorReason } from "./gateway-async.ts";
import { WebSocket } from "ws";
import type { AuthService } from "../../../packages/auth/src/index.ts";
import {
  FrameType,
  transitionSession,
  type SessionPolicy,
} from "../../../packages/protocol/src/index.ts";
import { sendCarrierFrame } from "../../../packages/relay/src/index.ts";
import type { GatewayMetrics } from "./metrics.ts";
import { retainAdmissionUntilSettled } from "./retained-operation.ts";
import type { GatewayEventSink } from "./gateway-session.ts";

/** Owns operational timers and the kill switch; close releases every timer. */
export function startGatewayOperations(
  input: Readonly<{
    sessions: ReadonlyMap<string, GatewaySession>;
    metrics: GatewayMetrics;
    emit: GatewayEventSink;
    authService: AuthService | undefined;
    now(): number;
    gatewayAdmissionReady(): boolean;
    initialKillSwitch: boolean;
    authCleanupTimeoutMs: number;
    heartbeatIntervalMs: number;
    carrierLeaseMs: number;
    authorizationMaxAgeMs: number;
    sessionTickIntervalMs: number;
    sessionPolicy: SessionPolicy;
    expireGatewaySession(session: GatewaySession, reason: string): void;
    terminateGatewaySession(session: GatewaySession, reason: string): void;
  }>,
) {
  const {
    sessions,
    metrics,
    emit,
    authService,
    now,
    gatewayAdmissionReady,
    authCleanupTimeoutMs,
    heartbeatIntervalMs,
    carrierLeaseMs,
    authorizationMaxAgeMs,
    sessionTickIntervalMs,
    sessionPolicy,
    expireGatewaySession,
    terminateGatewaySession,
  } = input;
  let killSwitchEnabled = input.initialKillSwitch;
  let authCleanupRunning = false;
  const authCleanupTimer = setInterval(() => {
    if (authService === undefined || authCleanupRunning) return;
    authCleanupRunning = true;
    let cleanup: Promise<void>;
    try {
      cleanup = authService.cleanupExpiredArtifacts();
    } catch (error) {
      authCleanupRunning = false;
      console.error(
        JSON.stringify({
          event: "auth_cleanup_failed",
          reason: toSafeErrorReason(error),
        }),
      );
      return;
    }
    const releaseCleanupAdmission = () => {
      authCleanupRunning = false;
    };
    retainAdmissionUntilSettled(cleanup, releaseCleanupAdmission);
    void withPromiseDeadline(cleanup, authCleanupTimeoutMs, "auth cleanup timed out").catch(
      (error: unknown) => {
        console.error(
          JSON.stringify({
            event: "auth_cleanup_failed",
            reason: toSafeErrorReason(error),
          }),
        );
      },
    );
  }, 10 * 60_000);
  authCleanupTimer.unref();

  const heartbeatTimer = setInterval(() => {
    const checkedAt = now();
    for (const session of sessions.values()) {
      const transport = captureGatewayTransport(session);
      if (transport.socket.readyState !== WebSocket.OPEN) continue;
      if (checkedAt - session.lastPongAt >= carrierLeaseMs) {
        transport.socket.close(1001, "carrier lease expired");
        continue;
      }
      void sendCarrierFrame(transport.socket, {
        type: FrameType.Ping,
        generation: transport.generation,
        streamId: 0,
      }).catch(() => {
        if (isCurrentGatewaySessionTransport(sessions, session, transport)) {
          transport.socket.close(1011, "heartbeat failed");
        }
      });
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  const sessionTimer = setInterval(() => {
    const checkedAt = now();
    for (const session of sessions.values()) {
      if (session.lifecycle.status !== "ACTIVE" && session.lifecycle.status !== "RECONNECTING")
        continue;
      const wasReconnecting = session.lifecycle.status === "RECONNECTING";
      const nextLifecycle = transitionSession(
        session.lifecycle,
        { type: "TICK", now: checkedAt },
        sessionPolicy,
      );
      const developerAuthorizationExpired =
        checkedAt >= session.developerAuthorizedAt + authorizationMaxAgeMs;
      if (nextLifecycle.status === "EXPIRED" || developerAuthorizationExpired) {
        session.lifecycle = nextLifecycle;
        expireGatewaySession(
          session,
          developerAuthorizationExpired
            ? "AUTHORIZATION_EXPIRED"
            : nextLifecycle.status === "EXPIRED"
              ? nextLifecycle.reason
              : "UNKNOWN",
        );
        continue;
      }
      if (wasReconnecting) continue;
      for (const [streamId, stream] of session.streams) {
        if (
          stream.reviewerAuthorizedAt === undefined ||
          checkedAt < stream.reviewerAuthorizedAt + authorizationMaxAgeMs
        ) {
          continue;
        }
        stream.cancelled = true;
        removeGatewayStream(session, streamId, stream, "LOCAL_RESET");
        stream.transport.outboundFlow.closeStream(streamId);
        if (stream.kind === "HTTP") {
          stream.response.destroy();
          stream.request.destroy();
        } else stream.browserSocket.destroy();
        void sendReset(stream.transport, streamId, "AUTHORIZATION_EXPIRED");
      }
    }
  }, sessionTickIntervalMs);
  sessionTimer.unref();

  return {
    setKillSwitch: updateKillSwitch,
    isKillSwitchEnabled: () => killSwitchEnabled,
    metricSnapshot,
    close(): void {
      clearInterval(authCleanupTimer);
      clearInterval(heartbeatTimer);
      clearInterval(sessionTimer);
    },
  };

  function updateKillSwitch(enabled: boolean): void {
    if (killSwitchEnabled === enabled) return;
    killSwitchEnabled = enabled;
    metrics.increment("kill_switch_changed");
    emit(enabled ? "kill_switch.enabled" : "kill_switch.disabled");
    if (!enabled) return;
    for (const session of sessions.values()) {
      terminateGatewaySession(session, "operational kill switch");
    }
  }

  function metricSnapshot() {
    let activeTunnels = 0;
    let reconnectingTunnels = 0;
    let activeStreams = 0;
    for (const session of sessions.values()) {
      if (session.lifecycle.status === "ACTIVE") activeTunnels += 1;
      else if (session.lifecycle.status === "RECONNECTING") reconnectingTunnels += 1;
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
