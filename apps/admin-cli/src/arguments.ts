import type { AccountRole } from "../../../packages/auth/src/index.ts";
import { ACCOUNT_ROLES } from "../../../packages/auth/src/index.ts";

export type AdminCommand =
  | Readonly<{ kind: "migrate" }>
  | Readonly<{ kind: "bootstrap"; username: string; displayName: string }>
  | Readonly<{ kind: "change-password"; username: string; passwordStdin: boolean }>
  | Readonly<{
      kind: "create-user";
      actorUsername: string;
      username: string;
      displayName: string;
      roles: readonly AccountRole[];
      passwordStdin: boolean;
    }>
  | Readonly<{ kind: "list-users"; actorUsername: string; passwordStdin: boolean }>
  | Readonly<{
      kind: "set-enabled";
      enabled: boolean;
      actorUsername: string;
      targetUsername: string;
      passwordStdin: boolean;
    }>
  | Readonly<{
      kind: "set-roles";
      actorUsername: string;
      targetUsername: string;
      roles: readonly AccountRole[];
      passwordStdin: boolean;
    }>
  | Readonly<{
      kind: "reset-password" | "revoke-sessions";
      actorUsername: string;
      targetUsername: string;
      passwordStdin: boolean;
    }>
  | Readonly<{
      kind: "record-canary";
      actorUsername: string;
      result: "PASSED" | "FAILED";
      deploymentId: string;
      configDigest: string;
      passwordStdin: boolean;
    }>
  | Readonly<{
      kind: "approve-admission" | "close-admission" | "admission-status";
      actorUsername: string;
      deploymentId: string;
      configDigest: string;
      passwordStdin: boolean;
    }>
  | Readonly<{
      kind: "set-kill-switch";
      enabled: boolean;
      actorUsername: string;
      passwordStdin: boolean;
    }>;

type CommandArgumentSpec = Readonly<{
  valueOptions: readonly string[];
  flags?: readonly string[];
}>;

const COMMAND_ARGUMENTS: Readonly<Record<string, CommandArgumentSpec>> = {
  migrate: { valueOptions: [] },
  bootstrap: { valueOptions: ["--username", "--display-name"] },
  "change-password": {
    valueOptions: ["--username"],
    flags: ["--password-stdin"],
  },
  "create-user": {
    valueOptions: ["--as", "--username", "--display-name", "--roles"],
    flags: ["--password-stdin"],
  },
  "list-users": { valueOptions: ["--as"], flags: ["--password-stdin"] },
  "disable-user": {
    valueOptions: ["--as", "--username"],
    flags: ["--password-stdin"],
  },
  "enable-user": {
    valueOptions: ["--as", "--username"],
    flags: ["--password-stdin"],
  },
  "set-roles": {
    valueOptions: ["--as", "--username", "--roles"],
    flags: ["--password-stdin"],
  },
  "reset-password": {
    valueOptions: ["--as", "--username"],
    flags: ["--password-stdin"],
  },
  "revoke-sessions": {
    valueOptions: ["--as", "--username"],
    flags: ["--password-stdin"],
  },
  "record-canary": {
    valueOptions: ["--as", "--result", "--deployment-id", "--config-digest"],
    flags: ["--password-stdin"],
  },
  "approve-admission": {
    valueOptions: ["--as", "--deployment-id", "--config-digest"],
    flags: ["--password-stdin"],
  },
  "close-admission": {
    valueOptions: ["--as", "--deployment-id", "--config-digest"],
    flags: ["--password-stdin"],
  },
  "admission-status": {
    valueOptions: ["--as", "--deployment-id", "--config-digest"],
    flags: ["--password-stdin"],
  },
  "enable-kill-switch": { valueOptions: ["--as"], flags: ["--password-stdin"] },
  "disable-kill-switch": { valueOptions: ["--as"], flags: ["--password-stdin"] },
};

export function parseAdminCommand(arguments_: readonly string[]): AdminCommand {
  const command = arguments_[0];
  const argumentSpec = command === undefined ? undefined : COMMAND_ARGUMENTS[command];
  if (argumentSpec === undefined) throw new Error(usage());
  validateArguments(arguments_, argumentSpec);
  if (command === "migrate") return { kind: "migrate" };
  if (command === "bootstrap") {
    return {
      kind: "bootstrap",
      username: requiredOption(arguments_, "--username"),
      displayName: requiredOption(arguments_, "--display-name"),
    };
  }
  if (command === "change-password") {
    return {
      kind: "change-password",
      username: requiredOption(arguments_, "--username"),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (command === "create-user") {
    return {
      kind: "create-user",
      actorUsername: requiredOption(arguments_, "--as"),
      username: requiredOption(arguments_, "--username"),
      displayName: requiredOption(arguments_, "--display-name"),
      roles: parseRoles(requiredOption(arguments_, "--roles")),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (command === "list-users") {
    return {
      kind: "list-users",
      actorUsername: requiredOption(arguments_, "--as"),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (command === "disable-user" || command === "enable-user") {
    return {
      kind: "set-enabled",
      enabled: command === "enable-user",
      actorUsername: requiredOption(arguments_, "--as"),
      targetUsername: requiredOption(arguments_, "--username"),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (command === "set-roles") {
    return {
      kind: "set-roles",
      actorUsername: requiredOption(arguments_, "--as"),
      targetUsername: requiredOption(arguments_, "--username"),
      roles: parseRoles(requiredOption(arguments_, "--roles")),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (command === "reset-password" || command === "revoke-sessions") {
    return {
      kind: command,
      actorUsername: requiredOption(arguments_, "--as"),
      targetUsername: requiredOption(arguments_, "--username"),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (command === "record-canary") {
    const result = requiredOption(arguments_, "--result").toUpperCase();
    if (result !== "PASSED" && result !== "FAILED") {
      throw new Error(`--result must be passed or failed\n\n${usage()}`);
    }
    return {
      kind: "record-canary",
      actorUsername: requiredOption(arguments_, "--as"),
      result,
      deploymentId: requiredOption(arguments_, "--deployment-id"),
      configDigest: requiredOption(arguments_, "--config-digest"),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (
    command === "approve-admission" ||
    command === "close-admission" ||
    command === "admission-status"
  ) {
    return {
      kind: command,
      actorUsername: requiredOption(arguments_, "--as"),
      deploymentId: requiredOption(arguments_, "--deployment-id"),
      configDigest: requiredOption(arguments_, "--config-digest"),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  if (command === "enable-kill-switch" || command === "disable-kill-switch") {
    return {
      kind: "set-kill-switch",
      enabled: command === "enable-kill-switch",
      actorUsername: requiredOption(arguments_, "--as"),
      passwordStdin: arguments_.includes("--password-stdin"),
    };
  }
  throw new Error(usage());
}

export function usage(): string {
  return `Usage:
  npm run admin -- migrate
  npm run admin -- bootstrap --username <id> --display-name <name>
  npm run admin -- change-password --username <id> [--password-stdin]
  npm run admin -- create-user --as <admin> --username <id> --display-name <name> --roles <roles>
  npm run admin -- list-users --as <admin>
  npm run admin -- enable-user|disable-user --as <admin> --username <id>
  npm run admin -- set-roles --as <admin> --username <id> --roles <roles>
  npm run admin -- reset-password|revoke-sessions --as <admin> --username <id>
  npm run admin -- record-canary --as <admin> --result passed|failed --deployment-id <id> --config-digest <sha256>
  npm run admin -- approve-admission|close-admission|admission-status --as <admin> --deployment-id <id> --config-digest <sha256>
  npm run admin -- enable-kill-switch|disable-kill-switch --as <admin>

Roles are comma-separated: ADMIN,DEVELOPER,REVIEWER`;
}

function requiredOption(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index < 0 ? undefined : arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} is required\n\n${usage()}`);
  return value;
}

function validateArguments(
  arguments_: readonly string[],
  spec: CommandArgumentSpec,
): void {
  const valueOptions = new Set(spec.valueOptions);
  const flags = new Set(spec.flags ?? []);
  const seen = new Set<string>();
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}\n\n${usage()}`);
    }
    if (!valueOptions.has(argument) && !flags.has(argument)) {
      throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
    }
    if (seen.has(argument)) {
      throw new Error(`Duplicate option: ${argument}\n\n${usage()}`);
    }
    seen.add(argument);
    if (flags.has(argument)) continue;
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} is required\n\n${usage()}`);
    }
    index += 1;
  }
}

function parseRoles(value: string): readonly AccountRole[] {
  const roles = value.split(",").map((role) => role.trim().toUpperCase());
  if (roles.length === 0 || roles.some((role) => !ACCOUNT_ROLES.includes(role as AccountRole))) {
    throw new Error(`Invalid roles: ${value}`);
  }
  return [...new Set(roles)] as AccountRole[];
}
