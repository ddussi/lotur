import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";

const marker = "review-tunnel-canary-v1";
const baseUrl = requiredUrl("CANARY_CONTENT_URL", ["https:", "http:"]);
const sessionCookie = required("CANARY_SESSION_COOKIE");
const allowInsecure = process.env.ALLOW_INSECURE_CANARY === "true";
if (!allowInsecure && baseUrl.protocol !== "https:") {
  throw new Error("CANARY_CONTENT_URL must use HTTPS unless ALLOW_INSECURE_CANARY=true");
}

const negative = await fetch(new URL("/", baseUrl), {
  redirect: "manual",
  headers: { accept: "text/html" },
});
if (![401, 303].includes(negative.status)) {
  throw new Error(`unauthenticated canary expected 401 or 303, received ${negative.status}`);
}

const authorized = await canaryFetch("/");
assertStatus(authorized, 200, "authorized request");
if (!(await authorized.text()).includes(marker)) throw new Error("authorized canary marker mismatch");

let uploadFinished = false;
const upload = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("first"));
    setTimeout(() => {
      controller.enqueue(new TextEncoder().encode("second"));
      controller.close();
      uploadFinished = true;
    }, 500).unref();
  },
});
const streamedRequest = await canaryFetch("/request-stream", {
  method: "POST",
  body: upload,
  duplex: "half",
});
assertStatus(streamedRequest, 200, "request streaming");
const requestReader = streamedRequest.body?.getReader();
if (requestReader === undefined) throw new Error("request streaming response has no body");
const requestFirst = await withTimeout(requestReader.read(), 2_000, "request streaming first byte");
if (uploadFinished || !new TextDecoder().decode(requestFirst.value).includes(`${marker}-request-first`)) {
  throw new Error("Ingress buffered the complete request body");
}
await requestReader.cancel();

const sse = await canaryFetch("/stream");
assertStatus(sse, 200, "SSE canary");
const sseReader = sse.body?.getReader();
if (sseReader === undefined) throw new Error("SSE response has no body");
const firstEvent = await withTimeout(sseReader.read(), 2_000, "SSE first event");
if (!new TextDecoder().decode(firstEvent.value).includes(`${marker}-first`)) {
  throw new Error("SSE first event marker mismatch");
}
await sseReader.cancel();

const websocketUrl = new URL("/websocket", baseUrl);
websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(websocketUrl, { headers: { cookie: sessionCookie } });
await onceWebSocket(socket, "open", 2_000);
const expected = randomBytes(32);
socket.send(expected);
const [received, isBinary] = await onceWebSocket(socket, "message", 2_000);
if (!isBinary || !Buffer.from(received).equals(expected)) {
  throw new Error("WebSocket binary echo mismatch");
}
socket.close(1000, "canary complete");
await onceWebSocket(socket, "close", 2_000);

console.log("Public-path canary passed: auth, request streaming, SSE, and WebSocket");

function canaryFetch(path, init = {}) {
  return fetch(new URL(path, baseUrl), {
    ...init,
    headers: { ...init.headers, cookie: sessionCookie, "cache-control": "no-store" },
  });
}

function assertStatus(response, expected, name) {
  if (response.status !== expected) {
    throw new Error(`${name} expected HTTP ${expected}, received ${response.status}`);
  }
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(name, protocols) {
  const value = new URL(required(name));
  if (!protocols.includes(value.protocol) || value.username !== "" || value.password !== "") {
    throw new Error(`${name} has an invalid URL`);
  }
  return value;
}

async function withTimeout(promise, timeoutMs, name) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function onceWebSocket(socket, event, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    const onEvent = (...values) => {
      cleanup();
      resolve(values);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off(event, onEvent);
      socket.off("error", onError);
    };
    socket.once(event, onEvent);
    socket.once("error", onError);
  }), timeoutMs, `WebSocket ${event}`);
}
