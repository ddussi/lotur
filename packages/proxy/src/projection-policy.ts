import type { HeaderPair, OriginProjection } from "../../protocol/src/index.ts";

const FORWARDED_HEADERS = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
]);

export type ProjectionContext = Readonly<{
  originProjection: OriginProjection;
  localOrigin: string;
  publicOrigin: string;
}>;

export function projectRequestHeaders(
  headers: readonly HeaderPair[],
  context: ProjectionContext,
): HeaderPair[] {
  const local = parseOrigin(context.localOrigin, "localOrigin");
  const publicUrl = parseOrigin(context.publicOrigin, "publicOrigin");
  const effective = context.originProjection === "local-view" ? local : publicUrl;
  const output: HeaderPair[] = [];

  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (lowerName === "host" || FORWARDED_HEADERS.has(lowerName)) continue;
    if (lowerName === "origin") {
      output.push([
        name,
        rewriteSameOriginValue(value, publicUrl, effective, false),
      ]);
      continue;
    }
    if (lowerName === "referer") {
      output.push([
        name,
        rewriteSameOriginValue(value, publicUrl, effective, true),
      ]);
      continue;
    }
    output.push([name, value]);
  }

  output.push(["Host", effective.host]);
  if (context.originProjection === "proxy-aware") {
    output.push(["Forwarded", `host="${escapeForwardedValue(publicUrl.host)}";proto=${publicUrl.protocol.slice(0, -1)}`]);
    output.push(["X-Forwarded-Host", publicUrl.host]);
    output.push(["X-Forwarded-Proto", publicUrl.protocol.slice(0, -1)]);
    output.push(["X-Forwarded-Port", publicUrl.port || (publicUrl.protocol === "https:" ? "443" : "80")]);
  }
  return output;
}

export function projectResponseHeaders(
  headers: readonly HeaderPair[],
  context: ProjectionContext & Readonly<{
    reservedCookieNames: ReadonlySet<string>;
  }>,
): HeaderPair[] {
  const local = parseOrigin(context.localOrigin, "localOrigin");
  const publicUrl = parseOrigin(context.publicOrigin, "publicOrigin");
  const effectiveHostname = context.originProjection === "local-view"
    ? local.hostname
    : publicUrl.hostname;
  const output: HeaderPair[] = [];

  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (lowerName === "set-cookie") {
      const projected = projectSetCookie(
        value,
        effectiveHostname,
        context.reservedCookieNames,
      );
      if (projected !== undefined) output.push([name, projected]);
      continue;
    }
    if (lowerName === "location") {
      output.push([name, rewriteLocalAbsoluteUrl(value, local, publicUrl)]);
      continue;
    }
    if (lowerName === "refresh") {
      output.push([name, rewriteRefresh(value, local, publicUrl)]);
      continue;
    }
    output.push([name, value]);
  }
  return output;
}

export function stripUntrustedForwardingHeaders(
  headers: readonly HeaderPair[],
): HeaderPair[] {
  return headers.filter(([name]) => !FORWARDED_HEADERS.has(name.toLowerCase()));
}

function rewriteSameOriginValue(
  value: string,
  expected: URL,
  replacement: URL,
  preservePath: boolean,
): string {
  if (value === "null") return value;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== expected.origin) return value;
    if (!preservePath) return replacement.origin;
    return `${replacement.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value;
  }
}

function rewriteLocalAbsoluteUrl(value: string, local: URL, publicUrl: URL): string {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== local.origin) return value;
    return `${publicUrl.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value;
  }
}

function rewriteRefresh(value: string, local: URL, publicUrl: URL): string {
  const match = /^(.*?\burl\s*=\s*)(["']?)(.*?)(\2)\s*$/i.exec(value);
  if (match === null) return value;
  const prefix = match[1];
  const quote = match[2] ?? "";
  const target = match[3];
  if (prefix === undefined || target === undefined) return value;
  return `${prefix}${quote}${rewriteLocalAbsoluteUrl(target, local, publicUrl)}${quote}`;
}

function projectSetCookie(
  value: string,
  effectiveHostname: string,
  reservedCookieNames: ReadonlySet<string>,
): string | undefined {
  const parts = value.split(";");
  const cookie = parts[0]?.trim();
  if (cookie === undefined) return undefined;
  const separator = cookie.indexOf("=");
  if (separator <= 0) return undefined;
  const cookieName = cookie.slice(0, separator).trim();
  if (
    reservedCookieNames.has(cookieName) ||
    cookieName.toLowerCase().startsWith("__host-rt_")
  ) {
    return undefined;
  }

  const output = [cookie];
  let domainSeen = false;
  for (const rawAttribute of parts.slice(1)) {
    const attribute = rawAttribute.trim();
    if (attribute === "") continue;
    const attributeSeparator = attribute.indexOf("=");
    const attributeName = (
      attributeSeparator < 0 ? attribute : attribute.slice(0, attributeSeparator)
    ).trim().toLowerCase();
    if (attributeName !== "domain") {
      output.push(attribute);
      continue;
    }
    if (domainSeen || attributeSeparator < 0) return undefined;
    domainSeen = true;
    const domain = attribute.slice(attributeSeparator + 1)
      .trim()
      .toLowerCase()
      .replace(/^\./, "")
      .replace(/\.$/, "");
    if (domain !== effectiveHostname.toLowerCase()) return undefined;
  }
  return output.join("; ");
}

function parseOrigin(value: string, name: string): URL {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== value
  ) {
    throw new TypeError(`${name} must be a canonical HTTP origin`);
  }
  return parsed;
}

function escapeForwardedValue(value: string): string {
  return value.replace(/["\\]/g, "");
}
