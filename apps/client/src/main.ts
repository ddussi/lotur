import { randomBytes } from "node:crypto";

import { readSecrets } from "../../../packages/cli-utils/src/secret-input.ts";
import { connectResilientTunnelClient } from "./client.ts";

const options = parseArguments(process.argv.slice(2));
const authentication = options.username === undefined
  ? undefined
  : await loginForCarrier(options);
const client = connectResilientTunnelClient({
  gatewayUrl: options.gatewayUrl,
  tunnelId: authentication?.tunnelId ?? options.tunnelId,
  localOrigin: options.localOrigin,
  ...(authentication === undefined
    ? {}
    : {
        carrierCredential: authentication.carrierCredential,
        issueCarrierCredential: authentication.issueResumeCredential,
      }),
  onStatus(status) {
    if (status.state === "reconnecting") {
      console.error(
        `Carrier disconnected (${status.error?.message ?? "transport error"}); ` +
        `reconnecting (attempt ${status.attempt ?? 1})`,
      );
    } else if (status.state === "active" && status.attempt !== undefined) {
      console.error("Carrier reconnected; the existing share URL is active again");
    } else if (status.state === "failed") {
      console.error(`Carrier recovery failed: ${status.error?.message ?? "unknown error"}`);
    }
  },
});

const activation = await client.ready;
console.log(`Tunnel ready: ${activation.shareUrl}`);
console.log(`Forwarding the complete origin ${options.localOrigin}; press Ctrl+C to stop.`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await client.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
void client.closed.then((outcome) => {
  if (outcome.reason === "failed") process.exitCode = 1;
});

type ClientOptions = Readonly<{
  localOrigin: string;
  gatewayUrl: string;
  tunnelId: string;
  contentDomain: string;
  reviewPort: number;
  reviewProtocol: "http:" | "https:";
  controlUrl: string;
  username?: string;
  passwordStdin: boolean;
}>;

function parseArguments(arguments_: readonly string[]): ClientOptions {
  const localOrigin = arguments_[0];
  if (localOrigin === undefined || localOrigin.startsWith("--")) {
    throw new Error(
      "Usage: npm run dev:client -- http://127.0.0.1:3000 [--gateway wss://control.example.net/_review-tunnel/carrier] [--username developer1]",
    );
  }
  const gatewayUrl = option(arguments_, "--gateway") ??
    process.env.GATEWAY_URL ??
    "ws://127.0.0.1:8787/_review-tunnel/carrier";
  const tunnelId = option(arguments_, "--tunnel-id") ?? randomBytes(16).toString("hex");
  const contentDomain = option(arguments_, "--content-domain") ??
    process.env.CONTENT_DOMAIN ??
    "localhost";
  const gateway = new URL(gatewayUrl);
  const reviewProtocol = gateway.protocol === "wss:" ? "https:" : "http:";
  const reviewPort = Number(
    option(arguments_, "--review-port") ??
      (gateway.port !== "" ? gateway.port : (reviewProtocol === "https:" ? "443" : "80")),
  );
  if (!Number.isInteger(reviewPort) || reviewPort < 1 || reviewPort > 65_535) {
    throw new Error("--review-port must be an integer between 1 and 65535");
  }
  const controlUrl = option(arguments_, "--control-url") ??
    process.env.CONTROL_URL ??
    `${gateway.protocol === "wss:" ? "https:" : "http:"}//${gateway.host}`;
  const username = option(arguments_, "--username") ?? process.env.REVIEW_TUNNEL_USERNAME;
  return {
    localOrigin,
    gatewayUrl,
    tunnelId,
    contentDomain,
    reviewPort,
    reviewProtocol,
    controlUrl,
    passwordStdin: arguments_.includes("--password-stdin"),
    ...(username === undefined ? {} : { username }),
  };
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function loginForCarrier(options: ClientOptions): Promise<Readonly<{
  carrierCredential: string;
  tunnelId: string;
  issueResumeCredential: (
    purpose: "resume",
    tunnelId: string,
  ) => Promise<string>;
}>> {
  const [password] = await readSecrets(["Review Tunnel password: "], options.passwordStdin);
  const login = await postForm(`${options.controlUrl}/api/client/login`, {
    username: options.username ?? "",
    password: password ?? "",
  });
  if (typeof login.sessionToken !== "string") throw new Error("Gateway returned an invalid login response");
  const sessionToken = login.sessionToken;
  const issued = await postForm(
    `${options.controlUrl}/api/carrier-credentials`,
    { purpose: "create" },
    sessionToken,
  );
  if (typeof issued.credential !== "string" || typeof issued.tunnelId !== "string") {
    throw new Error("Gateway returned an invalid Carrier credential");
  }
  return {
    carrierCredential: issued.credential,
    tunnelId: issued.tunnelId,
    async issueResumeCredential(purpose, tunnelId) {
      const resumed = await postForm(
        `${options.controlUrl}/api/carrier-credentials`,
        { purpose, tunnelId },
        sessionToken,
      );
      if (typeof resumed.credential !== "string") {
        throw new Error("Gateway returned an invalid Carrier credential");
      }
      return resumed.credential;
    },
  };
}

async function postForm(
  url: string,
  values: Readonly<Record<string, string>>,
  bearer?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-review-tunnel-client": "1",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: new URLSearchParams(values),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body
      ? String(body.error)
      : `HTTP_${response.status}`;
    throw new Error(`Gateway authentication failed: ${code}`);
  }
  if (typeof body !== "object" || body === null) throw new Error("Gateway returned invalid JSON");
  return body as Record<string, unknown>;
}
