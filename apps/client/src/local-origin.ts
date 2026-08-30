import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect as connectTcp, isIP } from "node:net";

export function parseLoopbackOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new TypeError("local origin must be a valid URL");
  }
  if (origin.username !== "" || origin.password !== "") {
    throw new TypeError("local origin must not include username or password credentials");
  }
  if (origin.protocol !== "http:") {
    throw new TypeError("Phase 1 local origin must use http");
  }
  if (!isLoopbackHost(origin.hostname)) {
    throw new TypeError("local origin must be loopback");
  }
  if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new TypeError("local origin must not include path, query, or fragment");
  }
  return origin;
}

export function fingerprintLocalOrigin(origin: URL): string {
  return createHash("sha256")
    .update("review-tunnel.v1.local-origin\0", "utf8")
    .update(origin.origin, "utf8")
    .digest("base64url");
}

export async function resolveAndProbeLocalOrigin(origin: URL): Promise<string> {
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) === 0
    ? (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address)
    : [hostname];
  if (addresses.length === 0 || addresses.some((address) => !isLoopbackAddress(address))) {
    throw new Error("local origin DNS must resolve exclusively to loopback addresses");
  }
  let lastError: unknown;
  for (const address of [...new Set(addresses)]) {
    try {
      await probeLocalOrigin(origin, address);
      return address;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("local origin is unavailable");
}

export async function probePinnedLocalOrigin(origin: URL, address: string): Promise<string> {
  if (!isLoopbackAddress(address)) throw new Error("pinned local origin is not loopback");
  await probeLocalOrigin(origin, address);
  return address;
}

async function probeLocalOrigin(origin: URL, address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connectTcp({
      host: address,
      port: Number(origin.port || "80"),
    });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("local origin probe timed out"));
    }, 1_500);
    timeout.unref();
    const cleanup = () => clearTimeout(timeout);
    socket.once("connect", () => {
      cleanup();
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  const firstOctet = Number(address.split(".", 1)[0]);
  return firstOctet === 127;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
