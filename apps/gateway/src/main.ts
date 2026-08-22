import { Pool } from "pg";

import { Argon2idPasswordHasher, AuthService } from "../../../packages/auth/src/index.ts";
import { OperationalStateCache } from "../../../packages/operations/src/index.ts";
import {
  PostgresAuthRepository,
  PostgresOperationalStateRepository,
} from "../../../packages/storage-postgres/src/index.ts";
import { readGatewayConfig } from "./config.ts";
import { createGatewayServer } from "./server.ts";

const config = readGatewayConfig(process.env);
const deploymentIdentity = config.deploymentIdentity;
let databasePool: Pool | undefined;
let authService: AuthService | undefined;
let operationalRepository: PostgresOperationalStateRepository | undefined;
let operationalState: OperationalStateCache | undefined;
if (
  config.databaseUrl !== undefined &&
  config.authSessionHmacKey !== undefined
) {
  databasePool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const repository = new PostgresAuthRepository(databasePool);
  if (config.autoMigrate) await repository.migrate();
  if (deploymentIdentity === undefined) {
    throw new Error("authenticated Gateway has no deployment identity");
  }
  operationalRepository = new PostgresOperationalStateRepository(databasePool);
  operationalState = new OperationalStateCache(deploymentIdentity);
  operationalState.apply(
    await operationalRepository.getOperationalState(deploymentIdentity),
  );
  const passwordHasher = new Argon2idPasswordHasher();
  authService = new AuthService({
    repository,
    passwordHasher,
    sessionHmacKey: config.authSessionHmacKey,
    ...(config.authSessionHmacPreviousKeys === undefined
      ? {}
      : { previousSessionHmacKeys: config.authSessionHmacPreviousKeys }),
    dummyPasswordHash: await passwordHasher.hash("constant-dummy-password-not-used"),
  });
  await authService.cleanupExpiredArtifacts();
}
const gateway = createGatewayServer({
  host: config.host,
  port: config.port,
  contentDomain: config.contentDomain,
  ...(config.publicContentOrigin === undefined
    ? {}
    : { publicContentOrigin: config.publicContentOrigin }),
  secureCookies: config.secureCookies,
  initialKillSwitch: operationalState?.isKillSwitchEnabled() ?? config.initialKillSwitch,
  gatewayAdmissionReady: () =>
    operationalState?.isAdmissionReady() ?? config.gatewayAdmissionReady,
  logger(event) {
    console.log(JSON.stringify(event));
  },
  ...(config.metricsBearerToken === undefined
    ? {}
    : { metricsBearerToken: config.metricsBearerToken }),
  ...(config.canaryHost === undefined ? {} : { canaryHost: config.canaryHost }),
  ...(config.canaryBearerToken === undefined
    ? {}
    : { canaryBearerToken: config.canaryBearerToken }),
  ...(config.sessionLimits === undefined ? {} : { sessionLimits: config.sessionLimits }),
  ...(config.heartbeatIntervalMs === undefined
    ? {}
    : { heartbeatIntervalMs: config.heartbeatIntervalMs }),
  ...(config.carrierLeaseMs === undefined ? {} : { carrierLeaseMs: config.carrierLeaseMs }),
  ...(config.authorizationMaxAgeMs === undefined
    ? {}
    : { authorizationMaxAgeMs: config.authorizationMaxAgeMs }),
  ...(config.authorizationCheckIntervalMs === undefined
    ? {}
    : { authorizationCheckIntervalMs: config.authorizationCheckIntervalMs }),
  ...(config.controlHost === undefined ? {} : { controlHost: config.controlHost }),
  ...(authService === undefined ? {} : { authService }),
  ...(operationalRepository === undefined ||
      operationalState === undefined ||
      deploymentIdentity === undefined
    ? {}
    : {
        async persistKillSwitch(enabled, actor) {
          const state = await operationalRepository.setKillSwitch(
            deploymentIdentity,
            enabled,
            actor.accountId,
            new Date(),
          );
          operationalState.apply(state);
        },
      }),
});
const port = await gateway.listen();

let operationalRefreshRunning = false;
const operationalStateTimer = operationalRepository === undefined ||
    operationalState === undefined ||
    deploymentIdentity === undefined
  ? undefined
  : setInterval(() => {
      if (operationalRefreshRunning) return;
      operationalRefreshRunning = true;
      void operationalRepository.getOperationalState(deploymentIdentity)
        .then((state) => {
          operationalState.apply(state);
          gateway.setKillSwitch(state.killSwitchEnabled);
        })
        .catch((error: unknown) => {
          operationalState.markUnavailable();
          console.error(JSON.stringify({
            event: "operational_state_refresh_failed",
            reason: error instanceof Error ? error.message : "unknown error",
          }));
        })
        .finally(() => {
          operationalRefreshRunning = false;
        });
    }, config.operationalStatePollIntervalMs ?? 2_000);
operationalStateTimer?.unref();

console.log(
  `Review Tunnel Gateway listening on ${config.host}:${port} for *.${config.contentDomain} (${authService === undefined ? "isolated POC without auth" : "internal account auth"})`,
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing Review Tunnel Gateway`);
  if (operationalStateTimer !== undefined) clearInterval(operationalStateTimer);
  await gateway.close();
  await databasePool?.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
