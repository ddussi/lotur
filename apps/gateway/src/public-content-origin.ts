export type PublicContentOrigin = Readonly<{
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
  origin: string;
}>;

export function parsePublicContentOrigin(
  value: string,
  contentDomain: string,
): PublicContentOrigin {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("PUBLIC_CONTENT_ORIGIN must be a canonical HTTP origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("PUBLIC_CONTENT_ORIGIN must be a canonical HTTP origin");
  }
  if (parsed.hostname.toLowerCase() !== contentDomain.toLowerCase()) {
    throw new TypeError("PUBLIC_CONTENT_ORIGIN hostname must match CONTENT_DOMAIN");
  }
  return Object.freeze({
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
    origin: parsed.origin,
  });
}

export function buildTunnelShareUrl(
  tunnelId: string,
  publicOrigin: PublicContentOrigin,
): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tunnelId)) {
    throw new TypeError("tunnelId is invalid");
  }
  const port = publicOrigin.port === "" ? "" : `:${publicOrigin.port}`;
  return `${publicOrigin.protocol}//${tunnelId}.${publicOrigin.hostname}${port}/`;
}
