import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

export const LAN_USAGE = `Usage:
  npm run share:lan -- http://127.0.0.1:3000 [--host 192.168.0.23] [--port 8787]

Options:
  --host <private IPv4>  공유에 사용할 이 컴퓨터의 Wi-Fi/LAN 주소
  --port <0-65535>      공유 포트. 기본값 0은 빈 포트를 자동 선택
  -h, --help            도움말 표시`;

export type LanCommand =
  | Readonly<{ kind: "help" }>
  | Readonly<{
      kind: "run";
      localOrigin: string;
      host?: string;
      port: number;
    }>;

export type NetworkInterfaceMap = Readonly<
  Record<string, readonly NetworkInterfaceInfo[] | undefined>
>;

export function parseLanArguments(arguments_: readonly string[]): LanCommand {
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--help" || arguments_[0] === "-h")
  ) return { kind: "help" };

  const localOrigin = arguments_[0];
  if (localOrigin === undefined || localOrigin.startsWith("-")) {
    throw new Error(LAN_USAGE);
  }
  validateLocalOrigin(localOrigin);

  const values = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option !== "--host" && option !== "--port") {
      throw new Error(`unknown option: ${option ?? ""}\n\n${LAN_USAGE}`);
    }
    if (values.has(option)) throw new Error(`${option} may only be provided once`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`${option} requires a value`);
    }
    values.set(option, value);
    index += 1;
  }

  const host = values.get("--host");
  if (host !== undefined && !isPrivateIpv4(host)) {
    throw new Error("--host must be an RFC 1918 private IPv4 address");
  }
  const rawPort = values.get("--port") ?? "0";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }

  return {
    kind: "run",
    localOrigin,
    ...(host === undefined ? {} : { host }),
    port,
  };
}

export function selectLanHost(
  interfaces: NetworkInterfaceMap,
  requestedHost?: string,
): Readonly<{ host: string; interfaceName: string }> {
  const candidates: Array<Readonly<{
    host: string;
    interfaceName: string;
    score: number;
  }>> = [];
  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (
        address.family !== "IPv4" ||
        address.internal ||
        !isPrivateIpv4(address.address)
      ) continue;
      candidates.push({
        host: address.address,
        interfaceName,
        score: interfaceScore(interfaceName),
      });
    }
  }

  if (requestedHost !== undefined) {
    const selected = candidates.find(({ host }) => host === requestedHost);
    if (selected === undefined) {
      throw new Error(`private IPv4 ${requestedHost} is not assigned to this computer`);
    }
    return { host: selected.host, interfaceName: selected.interfaceName };
  }
  const automaticCandidates = candidates.filter(({ score }) => score >= 0);
  automaticCandidates.sort((left, right) =>
    right.score - left.score ||
    left.interfaceName.localeCompare(right.interfaceName) ||
    left.host.localeCompare(right.host)
  );
  const selected = automaticCandidates[0];
  if (selected === undefined) {
    throw new Error(
      "No physical Wi-Fi/LAN private IPv4 was found. Connect this computer to Wi-Fi/LAN, then try again.",
    );
  }
  return { host: selected.host, interfaceName: selected.interfaceName };
}

function validateLocalOrigin(value: string): void {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("local origin must be a valid URL such as http://127.0.0.1:3000");
  }
  if (
    origin.protocol !== "http:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    !isLoopbackHostname(origin.hostname) ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(
      "local origin must be an HTTP loopback origin without a path, such as http://127.0.0.1:3000",
    );
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return Number(normalized.split(".")[0]) === 127;
}

function isPrivateIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  const first = octets[0];
  const second = octets[1];
  return first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function interfaceScore(name: string): number {
  const normalized = name.toLowerCase();
  if (/docker|podman|veth|bridge|br-|vmnet|utun|tun|tap|tailscale/.test(normalized)) {
    return -100;
  }
  if (/wi-?fi|wlan|wireless|airport/.test(normalized)) return 120;
  if (/^en\d+$/.test(normalized)) return normalized === "en0" ? 110 : 100;
  if (/^eth\d+$/.test(normalized)) return 90;
  return 10;
}
