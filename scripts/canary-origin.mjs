import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const host = "127.0.0.1";
const port = positiveInteger(process.env.CANARY_ORIGIN_PORT ?? "3900", "CANARY_ORIGIN_PORT");
const marker = "review-tunnel-canary-v1";

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://canary.invalid").pathname;
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end(`${marker}\n`);
    return;
  }
  if (path === "/stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    response.write(`data: ${marker}-first\n\n`);
    setTimeout(() => response.end(`data: ${marker}-second\n\n`), 500).unref();
    return;
  }
  if (path === "/request-stream" && request.method === "POST") {
    let started = false;
    request.on("data", () => {
      if (started) return;
      started = true;
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.write(`${marker}-request-first\n`);
    });
    request.once("end", () => response.end(`${marker}-request-end\n`));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
  response.end("not found\n");
});

const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
webSockets.on("connection", (socket) => {
  socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
});
server.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", "http://canary.invalid").pathname;
  if (path !== "/websocket") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket, request);
  });
});

await new Promise((resolve, reject) => {
  server.listen(port, host, resolve);
  server.once("error", reject);
});
console.log(`Canary origin listening on http://${host}:${port}`);

async function shutdown() {
  for (const socket of webSockets.clients) socket.terminate();
  await new Promise((resolve) => webSockets.close(resolve));
  await new Promise((resolve, reject) =>
    server.close((error) => error == null ? resolve() : reject(error))
  );
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}
