import { resolve } from "node:path";

import {
  executeRestoreOperation,
  parseRestoreCliArguments,
} from "./postgres-operations.mjs";
import { createSignalAwareCommandRunner } from "./postgres-process.mjs";
import {
  parsePostgresTarget,
  postgresEnvironment,
  postgresTargetConfirmation,
} from "./postgres-url.mjs";

const parsedArguments = parseRestoreCliArguments(process.argv.slice(2));
const databaseUrl = required("RESTORE_DATABASE_URL");
const inputPath = resolve(parsedArguments.inputPath);
const parsedTarget = parsePostgresTarget(
  databaseUrl,
  "RESTORE_DATABASE_URL",
);
const { target, databaseName } = parsedTarget;
if (databaseName === "" || ["postgres", "template0", "template1"].includes(databaseName)) {
  throw new Error("refusing to restore into a default PostgreSQL database");
}
const targetConfirmation = postgresTargetConfirmation(parsedTarget);
if (process.env.CONFIRM_RESTORE_TARGET !== targetConfirmation) {
  throw new Error(`set CONFIRM_RESTORE_TARGET exactly to ${targetConfirmation}`);
}

const runner = createSignalAwareCommandRunner();
try {
  await executeRestoreOperation({
    inputPath,
    databaseName,
    environment: postgresEnvironment(target),
    assertNotInterrupted: runner.assertNotInterrupted,
    runCommand(command, arguments_, environment) {
      return runner.run(command, arguments_, {
        env: environment,
        stdio: ["ignore", "inherit", "inherit"],
      });
    },
  });
} finally {
  runner.dispose();
}
console.log(`PostgreSQL restore completed for ${targetConfirmation}`);

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
