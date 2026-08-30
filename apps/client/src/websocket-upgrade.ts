import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { HeaderPair } from "../../../packages/protocol/src/index.ts";

export function hasValidWebSocketUpgrade(
  requestHeaders: readonly HeaderPair[],
  response: IncomingMessage,
): boolean {
  const keys = requestHeaders
    .filter(([name]) => name.toLowerCase() === "sec-websocket-key")
    .map(([, value]) => value.trim());
  const accepts = responseHeaderValues(response, "sec-websocket-accept");
  if (
    response.statusCode !== 101 ||
    keys.length !== 1 ||
    accepts.length !== 1 ||
    !headerHasToken(responseHeaderValues(response, "connection"), "upgrade") ||
    !headerIsSingleToken(responseHeaderValues(response, "upgrade"), "websocket")
  ) {
    return false;
  }
  const expected = createHash("sha1")
    .update(`${keys[0]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  if (accepts[0]?.trim() !== expected) return false;

  const offeredProtocols = commaSeparatedHeaderTokens(requestHeaders, "sec-websocket-protocol");
  const selectedProtocols = commaSeparatedValues(
    responseHeaderValues(response, "sec-websocket-protocol"),
  );
  if (
    selectedProtocols.length > 1 ||
    selectedProtocols.some((protocol) =>
      !isHttpToken(protocol) || !offeredProtocols.includes(protocol)
    )
  ) {
    return false;
  }

  return responseHeaderValues(response, "sec-websocket-extensions").length === 0;
}

function responseHeaderValues(response: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]?.toLowerCase() === name) {
      const value = response.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function headerHasToken(values: readonly string[], expected: string): boolean {
  return commaSeparatedValues(values).some((value) => value.toLowerCase() === expected);
}

function headerIsSingleToken(values: readonly string[], expected: string): boolean {
  const tokens = commaSeparatedValues(values);
  return tokens.length === 1 && tokens[0]?.toLowerCase() === expected;
}

function commaSeparatedHeaderTokens(
  headers: readonly HeaderPair[],
  name: string,
): string[] {
  return commaSeparatedValues(
    headers
      .filter(([headerName]) => headerName.toLowerCase() === name)
      .map(([, value]) => value),
  ).filter(isHttpToken);
}

function commaSeparatedValues(values: readonly string[]): string[] {
  return values.flatMap((value) => value.split(",").map((part) => part.trim()))
    .filter((value) => value !== "");
}

function isHttpToken(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}
