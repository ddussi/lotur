import { Pool } from "pg";

import { Argon2idPasswordHasher, AuthService } from "../../../packages/auth/src/index.ts";
import { PostgresAuthRepository } from "../../../packages/storage-postgres/src/index.ts";
import { readGatewayConfig } from "./config.ts";
import { createGatewayServer } from "./server.ts";

const config = readGatewayConfig(process.env);
let databasePool: Pool | undefined;
let authService: AuthService | undefined;
if (
  config.databaseUrl !== undefined &&
  config.authSessionHmacKey !== undefined
) {
  databasePool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const repository = new PostgresAuthRepository(databasePool);
  if (config.autoMigrate) await repository.migrate();
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
  secureCookies: config.secureCookies,
  initialKillSwitch: config.initialKillSwitch,
  gatewayAdmissionReady: () => config.gatewayAdmissionReady,
  logger(event) {
    console.log(JSON.stringify(event));
  },
  ...(config.metricsBearerToken === undefined
    ? {}
    : { metricsBearerToken: config.metricsBearerToken }),
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
});
const port = await gateway.listen();

console.log(
  `Review Tunnel Gateway listening on ${config.host}:${port} for *.${config.contentDomain} (${authService === undefined ? "isolated POC without auth" : "internal account auth"})`,
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing Review Tunnel Gateway`);
  await gateway.close();
  await databasePool?.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
