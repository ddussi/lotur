import type { HeaderPair } from "../../protocol/src/http-metadata.ts";

const STANDARD_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function sanitizeHopByHopHeaders(
  headers: readonly HeaderPair[],
): HeaderPair[] {
  const connectionTokens = new Set<string>();
  for (const [rawName, value] of headers) {
    if (rawName.toLowerCase() !== "connection") continue;
    for (const token of value.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized !== "") connectionTokens.add(normalized);
    }
  }

  return headers.filter(([rawName]) => {
    const name = rawName.toLowerCase();
    return !STANDARD_HOP_BY_HOP_HEADERS.has(name) && !connectionTokens.has(name);
  });
}

export function isolateGatewayCredentials(
  headers: readonly HeaderPair[],
  reservedCookieNames: ReadonlySet<string>,
): HeaderPair[] {
  const output: HeaderPair[] = [];
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith("x-review-tunnel-")) continue;
    if (lowerName === "cookie") {
      const kept = value.split(";").map((part) => part.trim()).filter((part) => {
        const separator = part.indexOf("=");
        const cookieName = separator < 0 ? part : part.slice(0, separator).trim();
        return !reservedCookieNames.has(cookieName);
      });
      if (kept.length > 0) output.push([name, kept.join("; ")]);
      continue;
    }
    if (lowerName === "set-cookie") {
      const separator = value.indexOf("=");
      const cookieName = (separator < 0 ? value : value.slice(0, separator)).trim();
      if (reservedCookieNames.has(cookieName)) continue;
    }
    output.push([name, value]);
  }
  return output;
}

export function rawHeadersToPairs(rawHeaders: readonly string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) pairs.push([name, value]);
  }
  return pairs;
}

export function headerPairsToOutgoingHeaders(
  headers: readonly HeaderPair[],
): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = Object.create(null);
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    const current = output[name];
    if (current === undefined) output[name] = value;
    else if (Array.isArray(current)) current.push(value);
    else output[name] = [current, value];
  }
  return output;
}
