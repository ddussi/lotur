import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export function writeRawError(socket: Duplex, statusCode: number, code: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: code });
  socket.end(
    `HTTP/1.1 ${statusCode} Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n${body}`,
  );
}

export function writeGatewayError(
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

export function writeHealth(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(statusCode === 200 ? "ok\n" : "unavailable\n");
}

export function writeMetrics(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}
