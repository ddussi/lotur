import { Pool } from "pg";

import {
  Argon2idPasswordHasher,
  AuthService,
  DEFAULT_AUDIT_EVENT_LIMITS,
  DEFAULT_AUTH_ARTIFACT_LIMITS,
  DEFAULT_LOGIN_THROTTLE_LIMITS,
} from "../../../packages/auth/src/index.ts";
import { OperationalStateCache } from "../../../packages/operations/src/index.ts";
import {
  PostgresAuthRepository,
  PostgresOperationalStateRepository,
} from "../../../packages/storage-postgres/src/index.ts";
import { readGatewayConfig } from "./config.ts";
import { retainAdmissionUntilSettled } from "./retained-operation.ts";
import { createGatewayServer } from "./server.ts";

const config = readGatewayConfig(process.env);
const databaseConnectionTimeoutMs = config.databaseConnectionTimeoutMs ?? 5_000;
const databaseQueryTimeoutMs = config.databaseQueryTimeoutMs ?? 3_000;
const deploymentIdentity = config.deploymentIdentity;
let databasePool: Pool | undefined;
let authService: AuthService | undefined;
let operationalRepository: PostgresOperationalStateRepository | undefined;
let operationalState: OperationalStateCache | undefined;
if (
  config.databaseUrl !== undefined &&
  config.authSessionHmacKey !== undefined
) {
  databasePool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: databaseConnectionTimeoutMs,
    query_timeout: databaseQueryTimeoutMs,
    statement_timeout: databaseQueryTimeoutMs,
    lock_timeout: databaseQueryTimeoutMs,
    idle_in_transaction_session_timeout: databaseQueryTimeoutMs,
  });
  const auditEventLimits = {
    global: config.maxAuditEvents ?? DEFAULT_AUDIT_EVENT_LIMITS.global,
    operationalReserve: config.auditOperationalReserve ??
      DEFAULT_AUDIT_EVENT_LIMITS.operationalReserve,
  };
  const repository = new PostgresAuthRepository(databasePool, { auditEventLimits });
  if (config.autoMigrate) await repository.migrate();
  if (deploymentIdentity === undefined) {
    throw new Error("authenticated Gateway has no deployment identity");
  }
  operationalRepository = new PostgresOperationalStateRepository(databasePool, {
    auditEventLimits,
  });
  operationalState = new OperationalStateCache(deploymentIdentity);
  operationalState.apply(await withDeadline(
    operationalRepository.getOperationalState(deploymentIdentity),
    databaseQueryTimeoutMs,
    "initial operational state query timed out",
  ));
  const passwordHasher = new Argon2idPasswordHasher();
  authService = new AuthService({
    repository,
    passwordHasher,
    sessionHmacKey: config.authSessionHmacKey,
    ...(config.authSessionHmacPreviousKeys === undefined
      ? {}
      : { previousSessionHmacKeys: config.authSessionHmacPreviousKeys }),
    authArtifactLimits: {
      ...DEFAULT_AUTH_ARTIFACT_LIMITS,
      sessions: {
        global: config.maxAuthSessions ?? DEFAULT_AUTH_ARTIFACT_LIMITS.sessions.global,
        perAccount: config.maxAuthSessionsPerAccount ??
          DEFAULT_AUTH_ARTIFACT_LIMITS.sessions.perAccount,
      },
      sessionExchanges: {
        global: config.maxSessionExchanges ??
          DEFAULT_AUTH_ARTIFACT_LIMITS.sessionExchanges.global,
        perAccount: config.maxSessionExchangesPerAccount ??
          DEFAULT_AUTH_ARTIFACT_LIMITS.sessionExchanges.perAccount,
      },
      carrierCredentials: {
        global: config.maxOutstandingCarrierCredentials ?? 128,
        perAccount: config.maxOutstandingCarrierCredentialsPerAccount ?? 8,
      },
    },
    loginThrottleLimits: {
      global: config.maxLoginThrottles ?? DEFAULT_LOGIN_THROTTLE_LIMITS.global,
    },
    authenticationEventSink: {
      write(event) {
        console.log(JSON.stringify({
          event: "authentication_event",
          ...event,
        }));
      },
      reportFailure() {
        console.error(JSON.stringify({ event: "authentication_event_sink_failed" }));
      },
    },
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
  authorizationQueryTimeoutMs: databaseQueryTimeoutMs,
  authCleanupTimeoutMs: databaseQueryTimeoutMs,
  ...(config.maxPendingTunnels === undefined
    ? {}
    : { maxPendingTunnels: config.maxPendingTunnels }),
  ...(config.maxActiveTunnels === undefined
    ? {}
    : { maxActiveTunnels: config.maxActiveTunnels }),
  ...(config.maxTunnelsPerAccount === undefined
    ? {}
    : { maxTunnelsPerAccount: config.maxTunnelsPerAccount }),
  ...(config.loginIntentsPerSourcePerMinute === undefined
    ? {}
    : { loginIntentsPerSourcePerMinute: config.loginIntentsPerSourcePerMinute }),
  ...(config.loginIntentsGlobalPerMinute === undefined
    ? {}
    : { loginIntentsGlobalPerMinute: config.loginIntentsGlobalPerMinute }),
  ...(config.maxConcurrentLoginAttempts === undefined
    ? {}
    : { maxConcurrentLoginAttempts: config.maxConcurrentLoginAttempts }),
  ...(config.maxConcurrentLoginAttemptsPerRemote === undefined
    ? {}
    : {
        maxConcurrentLoginAttemptsPerRemote:
          config.maxConcurrentLoginAttemptsPerRemote,
      }),
  ...(config.loginAttemptsPerMinute === undefined
    ? {}
    : { loginAttemptsPerMinute: config.loginAttemptsPerMinute }),
  ...(config.loginAttemptsPerRemotePerMinute === undefined
    ? {}
    : {
        loginAttemptsPerRemotePerMinute:
          config.loginAttemptsPerRemotePerMinute,
      }),
  ...(config.maxConcurrentWebAuthorizations === undefined
    ? {}
    : { maxConcurrentWebAuthorizations: config.maxConcurrentWebAuthorizations }),
  ...(config.maxConcurrentWebAuthorizationsPerRemote === undefined
    ? {}
    : {
        maxConcurrentWebAuthorizationsPerRemote:
          config.maxConcurrentWebAuthorizationsPerRemote,
      }),
  ...(config.trustedProxyCidrs === undefined
    ? {}
    : { trustedProxyCidrs: config.trustedProxyCidrs }),
  ...(config.maxForwardedForEntries === undefined
    ? {}
    : { maxForwardedForEntries: config.maxForwardedForEntries }),
  ...(config.maxOutstandingCarrierCredentials === undefined
    ? {}
    : {
        maxOutstandingCarrierCredentials:
          config.maxOutstandingCarrierCredentials,
      }),
  ...(config.maxOutstandingCarrierCredentialsPerAccount === undefined
    ? {}
    : {
        maxOutstandingCarrierCredentialsPerAccount:
          config.maxOutstandingCarrierCredentialsPerAccount,
      }),
  ...(config.carrierCredentialsPerMinute === undefined
    ? {}
    : { carrierCredentialsPerMinute: config.carrierCredentialsPerMinute }),
  ...(config.carrierCredentialsPerAccountPerMinute === undefined
    ? {}
    : {
        carrierCredentialsPerAccountPerMinute:
          config.carrierCredentialsPerAccountPerMinute,
      }),
  ...(config.maxPendingCarrierFrames === undefined
    ? {}
    : { maxPendingCarrierFrames: config.maxPendingCarrierFrames }),
  ...(config.maxPendingCarrierBytes === undefined
    ? {}
    : { maxPendingCarrierBytes: config.maxPendingCarrierBytes }),
  ...(config.maxCanaryWebSockets === undefined
    ? {}
    : { maxCanaryWebSockets: config.maxCanaryWebSockets }),
  ...(config.canaryWebSocketIdleTimeoutMs === undefined
    ? {}
    : { canaryWebSocketIdleTimeoutMs: config.canaryWebSocketIdleTimeoutMs }),
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
            {
              accountId: actor.accountId,
              accountAuthVersion: actor.authVersion,
            },
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
      const refresh = operationalRepository.getOperationalState(deploymentIdentity);
      const releaseRefreshAdmission = () => {
        operationalRefreshRunning = false;
      };
      retainAdmissionUntilSettled(refresh, releaseRefreshAdmission);
      void withDeadline(
        refresh,
        databaseQueryTimeoutMs,
        "operational state refresh timed out",
      )
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
        });
    }, config.operationalStatePollIntervalMs ?? 2_000);
operationalStateTimer?.unref();

console.log(
  `Review Tunnel Gateway listening on ${config.host}:${port} for *.${config.contentDomain} (${authService === undefined ? "isolated mode without auth" : "administrator-issued account auth"})`,
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

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
