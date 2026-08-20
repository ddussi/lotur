export type GatewayConfig = Readonly<{
  host: string;
  port: number;
  contentDomain: string;
  controlHost?: string;
  databaseUrl?: string;
  authSessionHmacKey?: Uint8Array;
  secureCookies: boolean;
  autoMigrate: boolean;
}>;

export function readGatewayConfig(
  environment: Readonly<Record<string, string | undefined>>,
): GatewayConfig {
  const host = environment.GATEWAY_HOST ?? "127.0.0.1";
  const port = parsePort(environment.GATEWAY_PORT ?? "8787");
  const contentDomain = parseDomain(environment.CONTENT_DOMAIN ?? "localhost");
  const insecureExternalPoc = environment.ALLOW_INSECURE_POC === "true";
  const databaseUrl = environment.DATABASE_URL;
  const controlHost = environment.CONTROL_HOST;
  const authSessionHmacKeyText = environment.AUTH_SESSION_HMAC_KEY;
  const insecureHttpAuth = environment.ALLOW_INSECURE_HTTP_AUTH === "true";

  if (!isLoopbackBindHost(host) && databaseUrl === undefined && !insecureExternalPoc) {
    throw new Error(
      "인증 없는 Phase 1 POC는 loopback에만 바인딩됩니다. 외부 바인딩은 보안 MVP에서 구성하세요.",
    );
  }

  if (databaseUrl !== undefined && (controlHost === undefined || authSessionHmacKeyText === undefined)) {
    throw new Error("DATABASE_URL auth mode requires CONTROL_HOST and AUTH_SESSION_HMAC_KEY");
  }
  if (databaseUrl === undefined && (controlHost !== undefined || authSessionHmacKeyText !== undefined)) {
    throw new Error("DATABASE_URL, CONTROL_HOST and AUTH_SESSION_HMAC_KEY must be configured together");
  }
  let authSessionHmacKey: Uint8Array | undefined;
  if (authSessionHmacKeyText !== undefined) {
    authSessionHmacKey = Buffer.from(authSessionHmacKeyText, "base64url");
    if (authSessionHmacKey.byteLength < 32) {
      throw new Error("AUTH_SESSION_HMAC_KEY must decode to at least 32 bytes");
    }
  }
  if (controlHost !== undefined) {
    const normalizedControlHost = parseDomain(controlHost);
    if (siteBoundary(normalizedControlHost) === siteBoundary(contentDomain)) {
      throw new Error("CONTROL_HOST and CONTENT_DOMAIN must use different browser site boundaries");
    }
  }
  if (insecureHttpAuth && !isLoopbackBindHost(host)) {
    throw new Error("ALLOW_INSECURE_HTTP_AUTH is only allowed on a loopback bind");
  }

  return {
    host,
    port,
    contentDomain,
    secureCookies: !insecureHttpAuth,
    autoMigrate: environment.AUTO_MIGRATE !== "false",
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(controlHost === undefined ? {} : { controlHost: parseDomain(controlHost) }),
    ...(authSessionHmacKey === undefined ? {} : { authSessionHmacKey }),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("GATEWAY_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseDomain(value: string): string {
  const normalized = value.toLowerCase().replace(/\.$/, "");
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes("://") ||
    !/^[a-z0-9.-]+$/.test(normalized) ||
    normalized.split(".").some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-"),
    )
  ) {
    throw new TypeError("CONTENT_DOMAIN must be a DNS hostname without scheme or wildcard");
  }
  return normalized;
}

function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function siteBoundary(hostname: string): string {
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}
import { getDomain } from "tldts";
