import { Pool } from "pg";

import {
  Argon2idPasswordHasher,
  AuthError,
  AuthService,
  normalizeUsername,
  type Principal,
} from "../../../packages/auth/src/index.ts";
import { PostgresAuthRepository } from "../../../packages/storage-postgres/src/index.ts";
import { readSecrets } from "../../../packages/cli-utils/src/secret-input.ts";
import { parseAdminCommand } from "./arguments.ts";

const databaseUrl = process.env.DATABASE_URL;
const hmacKeyText = process.env.AUTH_SESSION_HMAC_KEY;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
if (hmacKeyText === undefined) throw new Error("AUTH_SESSION_HMAC_KEY is required");
const hmacKey = Buffer.from(hmacKeyText, "base64url");
if (hmacKey.byteLength < 32) throw new Error("AUTH_SESSION_HMAC_KEY must decode to at least 32 bytes");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
try {
  const repository = new PostgresAuthRepository(pool);
  const command = parseAdminCommand(process.argv.slice(2));
  if (command.kind === "migrate") {
    await repository.migrate();
    console.log("Database migration complete.");
  } else {
    await repository.migrate();
    const hasher = new Argon2idPasswordHasher();
    const service = new AuthService({
      repository,
      passwordHasher: hasher,
      sessionHmacKey: hmacKey,
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
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function authenticateAdministrator(
  service: AuthService,
  username: string,
  passwordStdin: boolean,
): Promise<Principal> {
  const [password] = await readSecrets(["Administrator password: "], passwordStdin);
  const login = await service.authenticate({
    username,
    password: password ?? "",
    remoteAddress: "local-admin-cli",
  });
  if (!login.principal.roles.includes("ADMIN")) {
    throw new AuthError("FORBIDDEN", "관리자 권한이 필요합니다.");
  }
  if (login.principal.mustChangePassword) {
    throw new AuthError("PASSWORD_CHANGE_REQUIRED", "먼저 change-password 명령을 실행하세요.");
  }
  return login.principal;
}

function printTemporaryPassword(username: string, temporaryPassword: string): void {
  console.log(`Account: ${username}`);
  console.log(`One-time temporary password: ${temporaryPassword}`);
  console.log("This value will not be shown again. The user must change it on first login.");
}
