import { WebSocket, type RawData } from "ws";

export const CANARY_ECHO_MAX_PENDING_BYTES = 64 * 1024;

export type CanaryEchoState = Readonly<
  | { status: "IDLE"; pendingBytes: 0 }
  | { status: "SENDING"; pendingBytes: number }
  | { status: "CLOSED"; pendingBytes: 0 }
>;

export type CanaryEchoEvent = Readonly<
  | { type: "RECEIVE"; byteLength: number }
  | { type: "CONTROL_FRAME" }
  | { type: "SEND_COMPLETED" }
  | { type: "SEND_FAILED" }
  | { type: "SOCKET_CLOSED" }
>;

export type CanaryEchoAction = "NONE" | "SEND" | "TERMINATE";

export const INITIAL_CANARY_ECHO_STATE: CanaryEchoState = Object.freeze({
  status: "IDLE",
  pendingBytes: 0,
});

const CLOSED_CANARY_ECHO_STATE: CanaryEchoState = Object.freeze({
  status: "CLOSED",
  pendingBytes: 0,
});

export function transitionCanaryEcho(
  state: CanaryEchoState,
  event: CanaryEchoEvent,
): Readonly<{ state: CanaryEchoState; action: CanaryEchoAction }> {
  if (state.status === "CLOSED") {
    return { state, action: "NONE" };
  }
  if (event.type === "SOCKET_CLOSED") {
    return { state: CLOSED_CANARY_ECHO_STATE, action: "NONE" };
  }
  if (event.type === "SEND_FAILED") {
    return { state: CLOSED_CANARY_ECHO_STATE, action: "TERMINATE" };
  }
  if (event.type === "CONTROL_FRAME") {
    return { state: CLOSED_CANARY_ECHO_STATE, action: "TERMINATE" };
  }
  if (event.type === "SEND_COMPLETED") {
    return state.status === "SENDING"
      ? { state: INITIAL_CANARY_ECHO_STATE, action: "NONE" }
      : { state, action: "NONE" };
  }
  if (
    state.status !== "IDLE" ||
    !Number.isSafeInteger(event.byteLength) ||
    event.byteLength < 0 ||
    event.byteLength > CANARY_ECHO_MAX_PENDING_BYTES
  ) {
    return { state: CLOSED_CANARY_ECHO_STATE, action: "TERMINATE" };
  }
  return {
    state: { status: "SENDING", pendingBytes: event.byteLength },
    action: "SEND",
  };
}

export function attachCanaryWebSocketEcho(
  socket: WebSocket,
  idleTimeoutMs: number,
): void {
  let state = INITIAL_CANARY_ECHO_STATE;
  let cleaned = false;
  const idleTimer = setTimeout(() => {
    state = transitionCanaryEcho(state, { type: "SOCKET_CLOSED" }).state;
    try {
      socket.close(1008, "canary idle timeout");
    } catch {
      terminate();
    }
  }, idleTimeoutMs);
  idleTimer.unref();

  const touch = () => idleTimer.refresh();
  const terminate = () => {
    if (socket.readyState === WebSocket.CLOSED) {
      cleanup();
      return;
    }
    try {
      socket.terminate();
    } catch {
      cleanup();
    }
  };
  const applySendResult = (error?: Error | null) => {
    const decision = transitionCanaryEcho(state, {
      type: error == null ? "SEND_COMPLETED" : "SEND_FAILED",
    });
    state = decision.state;
    if (decision.action === "TERMINATE") terminate();
  };
  const onMessage = (data: RawData, isBinary: boolean) => {
    touch();
    const decision = transitionCanaryEcho(state, {
      type: "RECEIVE",
      byteLength: rawDataByteLength(data),
    });
    state = decision.state;
    if (decision.action === "TERMINATE") {
      terminate();
      return;
    }
    if (decision.action !== "SEND") return;
    try {
      socket.send(data, { binary: isBinary }, applySendResult);
    } catch (error) {
      applySendResult(error instanceof Error ? error : new Error("canary echo send failed"));
    }
  };
  const onControlFrame = () => {
    const decision = transitionCanaryEcho(state, { type: "CONTROL_FRAME" });
    state = decision.state;
    if (decision.action === "TERMINATE") terminate();
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state = transitionCanaryEcho(state, { type: "SOCKET_CLOSED" }).state;
    clearTimeout(idleTimer);
    socket.off("message", onMessage);
    socket.off("ping", onControlFrame);
    socket.off("pong", onControlFrame);
    socket.off("close", cleanup);
    socket.off("error", cleanup);
  };

  socket.on("message", onMessage);
  socket.on("ping", onControlFrame);
  socket.on("pong", onControlFrame);
  socket.once("close", cleanup);
  socket.once("error", cleanup);
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}
