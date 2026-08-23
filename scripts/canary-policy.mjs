export function withRequestDeadline(init = {}, timeoutMs = 5_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("canary timeout must be a positive safe integer");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal === undefined
    ? deadline
    : AbortSignal.any([init.signal, deadline]);
  return { ...init, signal };
}

export async function readIncrementalSseFirstEvent(
  reader,
  firstMarker,
  secondMarker,
  maxBytes = 4_096,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("SSE first event byte limit must be a positive safe integer");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done || result.value === undefined) {
      text += decoder.decode();
      throw new Error("SSE first event marker mismatch");
    }
    bytes += result.value.byteLength;
    if (bytes > maxBytes) {
      throw new Error(`SSE first event exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(result.value, { stream: true });
    const boundary = firstSseEventBoundary(text);
    if (boundary === undefined) continue;
    const firstEvent = text.slice(0, boundary);
    const trailing = text.slice(boundary);
    if (firstEvent.includes(secondMarker) || trailing !== "") {
      throw new Error("Ingress buffered beyond the first SSE event");
    }
    if (!firstEvent.includes(firstMarker)) {
      throw new Error("SSE first event marker mismatch");
    }
    return;
  }
}

function firstSseEventBoundary(value) {
  const lineFeed = value.indexOf("\n\n");
  const carriageReturn = value.indexOf("\r\n\r\n");
  if (lineFeed < 0 && carriageReturn < 0) return undefined;
  if (lineFeed < 0) return carriageReturn + 4;
  if (carriageReturn < 0) return lineFeed + 2;
  return Math.min(lineFeed + 2, carriageReturn + 4);
}

export function waitForWebSocketEvent(socket, event, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("WebSocket timeout must be a positive safe integer");
  }
  return new Promise((resolve, reject) => {
    let state = "WAITING";
    let terminationCleanupTimer;
    const timer = setTimeout(() => {
      if (state !== "WAITING") return;
      state = "TERMINATING";
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.once("close", onTerminationClose);
      terminationCleanupTimer = setTimeout(cleanup, 1_000);
      terminationCleanupTimer.unref();
      try {
        socket.terminate();
      } catch {
        cleanup();
      }
      reject(new Error(`WebSocket ${event} timed out`));
    }, timeoutMs);
    timer.unref();
    const onEvent = (...values) => {
      if (state !== "WAITING") return;
      state = "SETTLED";
      cleanup();
      resolve(values);
    };
    const onError = (error) => {
      if (state === "TERMINATING") {
        cleanup();
        return;
      }
      if (state !== "WAITING") return;
      state = "SETTLED";
      cleanup();
      reject(error);
    };
    const onTerminationClose = () => cleanup();
    const cleanup = () => {
      clearTimeout(timer);
      if (terminationCleanupTimer !== undefined) clearTimeout(terminationCleanupTimer);
      socket.off(event, onEvent);
      socket.off("error", onError);
      socket.off("close", onTerminationClose);
    };
    socket.once(event, onEvent);
    socket.on("error", onError);
  });
}
