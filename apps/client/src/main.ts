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
    const activation = await client.ready;
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
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "unknown error";
}
