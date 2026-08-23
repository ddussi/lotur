import { isIP } from "node:net";

const DEFAULT_MAX_FORWARDED_FOR_ENTRIES = 16;
const MAX_FORWARDED_FOR_BYTES = 2_048;
const MAX_TRUSTED_PROXY_CIDRS = 32;

type ParsedAddress = Readonly<{
  family: 4 | 6;
  value: bigint;
  canonical: string;
}>;

type ParsedCidr = Readonly<{
  family: 4 | 6;
  network: bigint;
  prefix: number;
}>;

export type ClientAddressResolverOptions = Readonly<{
  trustedProxyCidrs: readonly string[];
  maxForwardedForEntries?: number;
}>;

export type ClientAddressResolver = (
  peerAddress: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
) => string;

export function createClientAddressResolver(
  options: ClientAddressResolverOptions,
): ClientAddressResolver {
  if (options.trustedProxyCidrs.length > MAX_TRUSTED_PROXY_CIDRS) {
    throw new RangeError(`trustedProxyCidrs must contain at most ${MAX_TRUSTED_PROXY_CIDRS} CIDRs`);
  }
  const maxEntries = options.maxForwardedForEntries ?? DEFAULT_MAX_FORWARDED_FOR_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("maxForwardedForEntries must be a positive safe integer");
  }
  const trustedNetworks = options.trustedProxyCidrs.map(parseCidr);

  return (peerAddress, forwardedFor) => {
    const peer = peerAddress === undefined ? undefined : parseAddress(peerAddress);
    const peerIdentity = peer?.canonical ?? "unknown";
    if (
      peer === undefined ||
      trustedNetworks.length === 0 ||
      !isTrusted(peer, trustedNetworks) ||
      forwardedFor === undefined ||
      typeof forwardedFor !== "string" ||
      Buffer.byteLength(forwardedFor, "utf8") > MAX_FORWARDED_FOR_BYTES
    ) {
      return peerIdentity;
    }

    const entries = forwardedFor.split(",");
    if (entries.length === 0 || entries.length > maxEntries) return peerIdentity;
    const chain: ParsedAddress[] = [];
    for (const entry of entries) {
      const text = entry.trim();
      if (text === "") return peerIdentity;
      const address = parseAddress(text);
      if (address === undefined) return peerIdentity;
      chain.push(address);
    }

    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const address = chain[index];
      if (address !== undefined && !isTrusted(address, trustedNetworks)) {
        return address.canonical;
      }
    }
    return chain[0]?.canonical ?? peerIdentity;
  };
}

function parseCidr(text: string): ParsedCidr {
  const parts = text.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new TypeError(`trusted proxy value must be an explicit CIDR: ${text}`);
  }
  const sourceAddress = parseAddress(parts[0] ?? "", false);
  if (sourceAddress === undefined) throw new TypeError(`invalid trusted proxy CIDR address: ${text}`);
  const prefixText = parts[1] ?? "";
  if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) {
    throw new TypeError(`invalid trusted proxy CIDR prefix: ${text}`);
  }
  let family = sourceAddress.family;
  let value = sourceAddress.value;
  let prefix = Number(prefixText);
  const mapped = family === 6 && isMappedIpv4(value);
  if (mapped) {
    if (prefix < 96 || prefix > 128) {
      throw new TypeError(`IPv4-mapped trusted proxy CIDR prefix must be between 96 and 128: ${text}`);
    }
    family = 4;
    value &= 0xffff_ffffn;
    prefix -= 96;
  }
  const bits = family === 4 ? 32 : 128;
  if (prefix > bits) throw new TypeError(`trusted proxy CIDR prefix exceeds IPv${family} width: ${text}`);
  return {
    family,
    network: value & prefixMask(bits, prefix),
    prefix,
  };
}

function isTrusted(address: ParsedAddress, networks: readonly ParsedCidr[]): boolean {
  return networks.some((network) => {
    if (network.family !== address.family) return false;
    const bits = address.family === 4 ? 32 : 128;
    return (address.value & prefixMask(bits, network.prefix)) === network.network;
  });
}

function prefixMask(bits: 32 | 128, prefix: number): bigint {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

function parseAddress(text: string, normalizeMapped = true): ParsedAddress | undefined {
  const family = isIP(text);
  if (family === 4) {
    const octets = text.split(".").map(Number);
    if (octets.length !== 4) return undefined;
    const value = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
    return { family: 4, value, canonical: octets.join(".") };
  }
  if (family !== 6) return undefined;
  const groups = parseIpv6Groups(text);
  if (groups === undefined) return undefined;
  const value = groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
  if (normalizeMapped && isMappedIpv4(value)) {
    const ipv4 = value & 0xffff_ffffn;
    return { family: 4, value: ipv4, canonical: formatIpv4(ipv4) };
  }
  return { family: 6, value, canonical: formatIpv6(groups) };
}

function parseIpv6Groups(text: string): readonly number[] | undefined {
  let normalized = text.toLowerCase();
  const finalColon = normalized.lastIndexOf(":");
  const tail = normalized.slice(finalColon + 1);
  if (tail.includes(".")) {
    const ipv4 = parseAddress(tail);
    if (ipv4?.family !== 4) return undefined;
    normalized = `${normalized.slice(0, finalColon)}:${(Number(ipv4.value >> 16n)).toString(16)}:${Number(ipv4.value & 0xffffn).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : (halves[1] ?? "").split(":");
  const explicit = [...left, ...right];
  if (explicit.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const missing = 8 - explicit.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array(missing).fill(0) as number[],
    ...right.map((group) => Number.parseInt(group, 16)),
  ];
}

function isMappedIpv4(value: bigint): boolean {
  return (value >> 32n) === 0xffffn;
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 0xffn))
    .join(".");
}

function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((group) => group.toString(16)).join(":");
  const right = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(":");
  if (left === "" && right === "") return "::";
  if (left === "") return `::${right}`;
  if (right === "") return `${left}::`;
  return `${left}::${right}`;
}
