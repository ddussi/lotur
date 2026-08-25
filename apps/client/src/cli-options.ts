import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

export type ClientOptions = Readonly<{
  localOrigin: string;
  gatewayUrl: string;
  tunnelId: string;
  controlUrl: string;
  username?: string;
  passwordStdin: boolean;
}>;

export const CLIENT_USAGE =
  "Usage: npm run share -- http://127.0.0.1:3000 " +
  "[--gateway wss://control.tunnel.example.com/_review-tunnel/carrier] " +
  "[--username developer1]";

const VALUE_OPTIONS = new Set([
  "--gateway",
  "--tunnel-id",
  "--control-url",
  "--username",
]);
const FLAG_OPTIONS = new Set(["--password-stdin"]);

export function parseClientArguments(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ClientOptions {
  const localOrigin = arguments_[0];
  if (localOrigin === undefined || localOrigin.startsWith("--")) {
    throw new Error(CLIENT_USAGE);
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (VALUE_OPTIONS.has(argument)) {
      if (values.has(argument)) throw new Error(`${argument} may only be provided once`);
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(argument)) {
      if (flags.has(argument)) throw new Error(`${argument} may only be provided once`);
      flags.add(argument);
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    throw new Error(`unexpected positional argument: ${argument}`);
  }

  const gatewayUrl = values.get("--gateway") ??
    environment.GATEWAY_URL ??
    "ws://127.0.0.1:8787/_review-tunnel/carrier";
  const gateway = parseUrl(gatewayUrl, "Gateway URL");
  if (
    (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") ||
    !hasExactUrlPath(gatewayUrl, "/_review-tunnel/carrier") ||
    gateway.username !== "" ||
    gateway.password !== "" ||
    gateway.pathname !== "/_review-tunnel/carrier" ||
    gateway.search !== "" ||
    gateway.hash !== ""
  ) {
    throw new Error("Gateway URL is invalid");
  }
  const rawControlUrl = values.get("--control-url") ??
    environment.CONTROL_URL ??
    deriveControlUrl(gatewayUrl);
  const control = parseUrl(rawControlUrl, "Control URL");
  if (
    (control.protocol !== "http:" && control.protocol !== "https:") ||
    !hasExactUrlPath(rawControlUrl, "/") ||
    control.username !== "" ||
    control.password !== "" ||
    control.pathname !== "/" ||
    control.search !== "" ||
    control.hash !== ""
  ) {
    throw new Error("Control URL is invalid");
  }
  const controlUrl = control.origin;
  const username = values.get("--username") ?? environment.REVIEW_TUNNEL_USERNAME;
  if (username !== undefined && username.trim() === "") {
    throw new Error("username must not be empty");
  }
  if (username === undefined && flags.has("--password-stdin")) {
    throw new Error("--password-stdin requires --username or REVIEW_TUNNEL_USERNAME");
  }
  if (username === undefined && values.has("--control-url")) {
    throw new Error("--control-url requires --username or REVIEW_TUNNEL_USERNAME");
  }
  if (username !== undefined && values.has("--tunnel-id")) {
    throw new Error("--tunnel-id cannot be used in authenticated mode");
  }
  if (username !== undefined) {
    if (gateway.host !== control.host) {
      throw new Error(
        "authenticated Gateway and Control URLs must use the same origin mapping",
      );
    }
    const securePair = gateway.protocol === "wss:" && control.protocol === "https:";
    const loopbackPair = gateway.protocol === "ws:" &&
      control.protocol === "http:" &&
      isLoopbackHostname(gateway.hostname);
    if (!securePair && !loopbackPair) {
      throw new Error(
        "authenticated mode requires HTTPS and WSS except on an explicit loopback host",
      );
    }
  }
  const tunnelId = values.get("--tunnel-id") ?? randomBytes(16).toString("hex");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tunnelId)) {
    throw new Error("--tunnel-id is invalid");
  }

  return {
    localOrigin,
    gatewayUrl,
    tunnelId,
    controlUrl,
    passwordStdin: flags.has("--password-stdin"),
    ...(username === undefined ? {} : { username }),
  };
}

export function safeLocalOriginForDisplay(value: string): string {
  return new URL(value).origin;
}

function deriveControlUrl(gatewayUrl: string): string {
  const gateway = new URL(gatewayUrl);
  return `${gateway.protocol === "wss:" ? "https:" : "http:"}//${gateway.host}`;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
}

function hasExactUrlPath(value: string, expectedPath: string): boolean {
  const match = /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#\\]+(\/[^?#]*)?$/.exec(value);
  if (match === null) return false;
  const rawPath = match[1];
  return rawPath === expectedPath || (expectedPath === "/" && rawPath === undefined);
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return normalized === "::1";
}
