import type { AdminCommand } from "./arguments.ts";

export type AdminCommandRuntimePolicy = Readonly<{
  runMigration: boolean;
  requiresAuthService: boolean;
}>;

export function adminCommandRuntimePolicy(
  command: AdminCommand,
): AdminCommandRuntimePolicy {
  return command.kind === "migrate"
    ? { runMigration: true, requiresAuthService: false }
    : { runMigration: false, requiresAuthService: true };
}
