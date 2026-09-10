import manifest from "../package.json" with { type: "json" };
import { readSecrets } from "../../../packages/cli-utils/src/secret-input.ts";
import {
  CLIENT_USAGE,
  parseClientArguments,
  safeLocalOriginForDisplay,
  type ClientOptions,
} from "./cli-options.ts";
import { connectResilientTunnelClient } from "./client.ts";
import {
  createCarrierAuthentication,
  type CarrierAuthentication,
} from "./control-client.ts";
import { bindReviewOrClose } from "./review-binding.ts";
import { diagnoseClient, explainClientFailure } from "./diagnostics.ts";
import { parseLoopbackOrigin, resolveAndProbeLocalOrigin } from "./local-origin.ts";

const clientArguments = process.argv.slice(2);
if (
  (clientArguments.length === 1 && (clientArguments[0] === "--help" || clientArguments[0] === "-h")) ||
  (clientArguments.length === 2 && clientArguments[0] === "doctor" && ["--help", "-h"].includes(clientArguments[1]!))
) {
  console.log(CLIENT_USAGE);
} else if (clientArguments.length === 1 && clientArguments[0] === "--version") {
  console.log(manifest.version);
} else {
  try {
    if (clientArguments[0] === "doctor") {
      const options = parseClientArguments(clientArguments.slice(1));
      const passed = await diagnoseClient({ options,
        readPassword: async () => (await readSecrets(["Review Tunnel password: "], options.passwordStdin))[0] ?? "",
        report: check => console.log(`${check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "–"} ${check.name}: ${check.message}`),
      });
      console.log("진단은 공유를 시작하지 않습니다. 실제 터널·화면·리뷰 동작은 공유 후 확인하세요.");
      if (!passed) process.exitCode = 1;
    } else await runClient(clientArguments);
  }
  catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}

async function runClient(arguments_: readonly string[]): Promise<void> {
  const options = parseClientArguments(arguments_);
  try { await resolveAndProbeLocalOrigin(parseLoopbackOrigin(options.localOrigin)); }
  catch (error) { throw new Error(explainClientFailure(error, "local")); }
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

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void client.close().catch((error: unknown) => {
      process.exitCode = 1;
      console.error(`Tunnel shutdown failed: ${errorMessage(error)}`);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const activation = await client.ready.catch(error => {
      throw new Error(explainClientFailure(error, "tunnel"));
    });
    await bindReviewOrClose({
      ...(options.review === undefined ? {} : { review: options.review }),
      tunnelId: activation.tunnelId,
      bindReview(binding) {
        if (authentication === undefined) {
          throw new Error("review mode requires an authenticated Control session");
        }
        return authentication.bindReview(binding);
      },
      closeTunnel() {
        return client.close();
      },
    });
    console.log(`Tunnel ready: ${activation.shareUrl}`);
    if (options.review !== undefined) {
      console.log(
        `Review: project=${options.review.projectSlug} revision=${options.review.revisionKey}`,
      );
      console.log(`Changes at share start (developer-reported): ${options.review.workingTree ?? "unknown"}; live code can change after this report.`);
    }
    console.log(
      `Forwarding the complete origin ${safeLocalOriginForDisplay(options.localOrigin)}; ` +
      "press Ctrl+C to stop.",
    );
    const outcome = await client.closed;
    if (outcome.reason === "failed") process.exitCode = 1;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await authentication?.close().catch((error: unknown) => {
      process.exitCode = 1;
      console.error(`CLI authentication session cleanup failed: ${errorMessage(error)}`);
    });
  }
}

async function loginForCarrier(options: ClientOptions): Promise<CarrierAuthentication> {
  const [password] = await readSecrets(["Review Tunnel password: "], options.passwordStdin);
  return createCarrierAuthentication({
    controlUrl: options.controlUrl,
    username: options.username ?? "",
    password: password ?? "",
  }).catch(error => { throw new Error(explainClientFailure(error, "account")); });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "unknown error";
}
