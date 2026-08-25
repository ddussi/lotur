import { readSecrets } from "../../../packages/cli-utils/src/secret-input.ts";
import {
  CLIENT_USAGE,
  parseClientArguments,
  safeLocalOriginForDisplay,
  type ClientOptions,
} from "./cli-options.ts";
import { connectResilientTunnelClient } from "./client.ts";

const clientArguments = process.argv.slice(2);
if (
  clientArguments.length === 1 &&
  (clientArguments[0] === "--help" || clientArguments[0] === "-h")
) {
  console.log(CLIENT_USAGE);
} else {
  await runClient(clientArguments);
}

async function runClient(arguments_: readonly string[]): Promise<void> {
  const options = parseClientArguments(arguments_);
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
  console.log(
    `Forwarding the complete origin ${safeLocalOriginForDisplay(options.localOrigin)}; ` +
    "press Ctrl+C to stop.",
  );

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
}

async function loginForCarrier(options: ClientOptions): Promise<Readonly<{
  carrierCredential: string;
  tunnelId: string;
  issueResumeCredential: (
    purpose: "resume",
    tunnelId: string,
    signal: AbortSignal,
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
    async issueResumeCredential(purpose, tunnelId, signal) {
      const resumed = await postForm(
        `${options.controlUrl}/api/carrier-credentials`,
        { purpose, tunnelId },
        sessionToken,
        signal,
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const requestSignal = signal === undefined
    ? AbortSignal.timeout(10_000)
    : AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-review-tunnel-client": "1",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: new URLSearchParams(values),
    signal: requestSignal,
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
