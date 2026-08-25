import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

import { connectResilientTunnelClient, type TunnelClient } from "../../client/src/client.ts";
import { createGatewayServer } from "../../gateway/src/server.ts";
import { LAN_USAGE, parseLanArguments, selectLanHost } from "./options.ts";

await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const command = parseLanArguments(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(LAN_USAGE);
    return;
  }

  const selected = selectLanHost(networkInterfaces(), command.host);
  const gateway = createGatewayServer({
    host: selected.host,
    port: command.port,
    contentDomain: selected.host,
    contentRouting: "lan-cookie",
  });
  let client: TunnelClient | undefined;
  let closing = false;

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await client?.close().catch(() => undefined);
    await gateway.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  try {
    const gatewayPort = await gateway.listen();
    client = connectResilientTunnelClient({
      gatewayUrl: `ws://${selected.host}:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId: randomBytes(16).toString("hex"),
      localOrigin: command.localOrigin,
      onStatus(status) {
        if (status.state === "reconnecting") {
          console.error(`연결이 끊겨 재시도 중입니다. (${status.attempt ?? 1}회)`);
        } else if (status.state === "active" && status.attempt !== undefined) {
          console.error("연결이 복구되었습니다.");
        } else if (status.state === "failed") {
          console.error(`공유 연결 복구 실패: ${status.error?.message ?? "알 수 없는 오류"}`);
        }
      },
    });
    const activation = await client.ready;

    console.log("");
    console.log("로컬 네트워크 공유가 시작되었습니다.");
    console.log(`공유 주소: ${activation.shareUrl}`);
    console.log(`사용 주소: ${selected.host} (${selected.interfaceName})`);
    console.log("선택한 IP에 접근할 수 있는 휴대폰이나 다른 컴퓨터에서 공유 주소를 여세요.");
    console.log("주의: 신뢰할 수 있는 개인 Wi-Fi에서만 사용하세요. 종료: Ctrl+C");

    void client.closed.then(async (outcome) => {
      if (closing) return;
      closing = true;
      if (outcome.reason === "failed") process.exitCode = 1;
      await gateway.close().catch(() => undefined);
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}
