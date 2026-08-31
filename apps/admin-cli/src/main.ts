import { Pool } from "pg";

import {
  Argon2idPasswordHasher,
  AuthError,
  AuthService,
  DEFAULT_AUDIT_EVENT_LIMITS,
  DEFAULT_LOGIN_THROTTLE_LIMITS,
  normalizeUsername,
  validateAuditEventLimits,
  type AccountAuthorization,
} from "../../../packages/auth/src/index.ts";
import {
  OperationalStateCache,
  OperationalStateError,
  parseDeploymentIdentity,
  type DeploymentIdentity,
  type OperationalState,
} from "../../../packages/operations/src/index.ts";
import {
  PostgresAuthRepository,
  PostgresOperationalStateRepository,
  PostgresReviewRepository,
} from "../../../packages/storage-postgres/src/index.ts";
import { readSecrets } from "../../../packages/cli-utils/src/secret-input.ts";
import { parseAdminCommand, usage, type AdminCommand } from "./arguments.ts";

const adminArguments = process.argv.slice(2);
if (
  adminArguments.length === 1 &&
  (adminArguments[0] === "--help" || adminArguments[0] === "-h")
) {
  console.log(usage());
} else {
  await runAdmin(adminArguments);
}

async function runAdmin(arguments_: readonly string[]): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  const command = parseAdminCommand(arguments_);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  try {
    const auditEventLimits = validateAuditEventLimits({
      global: readBoundedPositiveSafeInteger(
        process.env.MAX_AUDIT_EVENTS,
        "MAX_AUDIT_EVENTS",
        DEFAULT_AUDIT_EVENT_LIMITS.global,
        100_000_000,
      ),
      operationalReserve: readBoundedPositiveSafeInteger(
        process.env.AUDIT_OPERATIONAL_RESERVE,
        "AUDIT_OPERATIONAL_RESERVE",
        DEFAULT_AUDIT_EVENT_LIMITS.operationalReserve,
        10_000_000,
      ),
    });
    const maxLoginThrottles = readBoundedPositiveSafeInteger(
      process.env.MAX_LOGIN_THROTTLES,
      "MAX_LOGIN_THROTTLES",
      DEFAULT_LOGIN_THROTTLE_LIMITS.global,
      10_000_000,
    );
    if (maxLoginThrottles < 2) {
      throw new Error("MAX_LOGIN_THROTTLES must be at least 2");
    }
    const repository = new PostgresAuthRepository(pool, { auditEventLimits });
    const operationalRepository = new PostgresOperationalStateRepository(pool, {
      auditEventLimits,
    });
    if (command.kind === "migrate") {
      await repository.migrate();
      await new PostgresReviewRepository(pool).migrate();
      console.log("Database migration complete.");
    } else {
      const hmacKeyText = process.env.AUTH_SESSION_HMAC_KEY;
      if (hmacKeyText === undefined) throw new Error("AUTH_SESSION_HMAC_KEY is required");
      const hmacKey = Buffer.from(hmacKeyText, "base64url");
      if (hmacKey.byteLength < 32) {
        throw new Error("AUTH_SESSION_HMAC_KEY must decode to at least 32 bytes");
      }
      const hasher = new Argon2idPasswordHasher();
      const service = new AuthService({
        repository,
        passwordHasher: hasher,
        sessionHmacKey: hmacKey,
        loginThrottleLimits: { global: maxLoginThrottles },
        authenticationEventSink: {
          write(event) {
            console.error(JSON.stringify({
              event: "authentication_event",
              ...event,
            }));
          },
          reportFailure() {
            console.error(JSON.stringify({ event: "authentication_event_sink_failed" }));
          },
        },
        dummyPasswordHash: await hasher.hash("constant-dummy-password-not-used"),
      });
      if (command.kind === "bootstrap") {
        const result = await service.bootstrapAdministrator(command);
        printTemporaryPassword(result.account.username, result.temporaryPassword);
      } else if (command.kind === "change-password") {
        const [currentPassword, newPassword, confirmation] = await readSecrets(
          ["Current password: ", "New password: ", "Confirm new password: "],
          command.passwordStdin,
        );
        if (newPassword !== confirmation) throw new Error("New password confirmation does not match");
        const login = await service.authenticate({
          username: command.username,
          password: currentPassword ?? "",
          remoteAddress: "local-admin-cli",
        });
        await service.changeOwnPassword(login.principal, {
          currentPassword: currentPassword ?? "",
          newPassword: newPassword ?? "",
        });
        console.log("Password changed. Existing sessions were revoked.");
      } else if (isOperationalCommand(command)) {
        const actor = await authenticateAdministrator(
          service,
          command.actorUsername,
          command.passwordStdin,
        );
        const identity = command.kind === "set-kill-switch"
          ? deploymentIdentityFromEnvironment()
          : parseDeploymentIdentity(command.deploymentId, command.configDigest);
        const operationalActor = {
          accountId: actor.accountId,
          accountAuthVersion: actor.authVersion,
        };
        let state: OperationalState;
        if (command.kind === "record-canary") {
          state = await operationalRepository.recordCanaryResult(
            identity,
            command.result,
            operationalActor,
            new Date(),
          );
        } else if (command.kind === "approve-admission") {
          state = await operationalRepository.approveAdmission(
            identity,
            operationalActor,
            new Date(),
          );
        } else if (command.kind === "close-admission") {
          state = await operationalRepository.closeAdmission(
            identity,
            operationalActor,
            new Date(),
          );
        } else if (command.kind === "set-kill-switch") {
          state = await operationalRepository.setKillSwitch(
            identity,
            command.enabled,
            operationalActor,
            new Date(),
          );
        } else {
          state = await operationalRepository.getOperationalState(identity);
        }
        printOperationalState(state);
      } else {
        const actor = await authenticateAdministrator(service, command.actorUsername, command.passwordStdin);
        if (command.kind === "create-user") {
          const result = await service.createAccount(actor, command);
          printTemporaryPassword(result.account.username, result.temporaryPassword);
        } else if (command.kind === "list-users") {
          const accounts = await service.listAccounts(actor);
          for (const account of accounts) {
            console.log([
              account.username,
              account.displayName,
              account.roles.join(","),
              account.enabled ? "enabled" : "disabled",
              account.mustChangePassword ? "password-change-required" : "ready",
            ].join("\t"));
          }
        } else {
          const target = await repository.findAccountByUsername(normalizeUsername(command.targetUsername));
          if (target === undefined) throw new AuthError("ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다.");
          if (command.kind === "set-enabled") {
            await service.setAccountEnabled(actor, target.id, command.enabled);
            console.log(`${target.username} is now ${command.enabled ? "enabled" : "disabled"}.`);
          } else if (command.kind === "set-roles") {
            await service.setAccountRoles(actor, target.id, command.roles);
            console.log(`${target.username} roles updated.`);
          } else if (command.kind === "reset-password") {
            const result = await service.resetPassword(actor, target.id);
            printTemporaryPassword(result.account.username, result.temporaryPassword);
          } else {
            await service.revokeSessions(actor, target.id);
            console.log(`${target.username} sessions revoked.`);
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(`${error.code}: ${error.message}`);
    } else if (error instanceof OperationalStateError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function isOperationalCommand(
  command: AdminCommand,
): command is Extract<AdminCommand, { kind:
  | "record-canary"
  | "approve-admission"
  | "close-admission"
  | "admission-status"
  | "set-kill-switch"
}> {
  return [
    "record-canary",
    "approve-admission",
    "close-admission",
    "admission-status",
    "set-kill-switch",
  ].includes(command.kind);
}

function deploymentIdentityFromEnvironment(): DeploymentIdentity {
  const deploymentId = process.env.DEPLOYMENT_ID;
  const configDigest = process.env.DEPLOYMENT_CONFIG_DIGEST;
  if (deploymentId === undefined || configDigest === undefined) {
    throw new Error(
      "DEPLOYMENT_ID and DEPLOYMENT_CONFIG_DIGEST are required for kill switch commands",
    );
  }
  return parseDeploymentIdentity(deploymentId, configDigest);
}

function printOperationalState(state: OperationalState): void {
  const cache = new OperationalStateCache(state.identity);
  cache.apply(state);
  console.log(JSON.stringify({
    deploymentId: state.identity.deploymentId,
    configDigest: state.identity.configDigest,
    killSwitchEnabled: state.killSwitchEnabled,
    canaryStatus: state.canaryStatus,
    canaryCheckedAt: state.canaryCheckedAt?.toISOString() ?? null,
    admissionApprovedAt: state.admissionApprovedAt?.toISOString() ?? null,
    admissionApprovedBy: state.admissionApprovedBy ?? null,
    admissionReady: cache.isAdmissionReady(),
    updatedAt: state.updatedAt.toISOString(),
  }));
}

async function authenticateAdministrator(
  service: AuthService,
  username: string,
  passwordStdin: boolean,
): Promise<AccountAuthorization> {
  const [password] = await readSecrets(["Administrator password: "], passwordStdin);
  return service.verifyAdministratorCredentials({
    username,
    password: password ?? "",
    remoteAddress: "local-admin-cli",
  });
}

function printTemporaryPassword(username: string, temporaryPassword: string): void {
  console.log(`Account: ${username}`);
  console.log(`One-time temporary password: ${temporaryPassword}`);
  console.log("This value will not be shown again. The user must change it on first login.");
}

function readBoundedPositiveSafeInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  if (parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return parsed;
}
