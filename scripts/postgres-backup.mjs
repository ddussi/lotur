import { resolve } from "node:path";

import {
  executeBackupOperation,
  parseBackupCliArguments,
} from "./postgres-operations.mjs";
import { createSignalAwareCommandRunner } from "./postgres-process.mjs";
import { parsePostgresTarget, postgresEnvironment } from "./postgres-url.mjs";

const parsedArguments = parseBackupCliArguments(process.argv.slice(2));
const databaseUrl = required("DATABASE_URL");
const { target } = parsePostgresTarget(databaseUrl, "DATABASE_URL");
const runner = createSignalAwareCommandRunner();
let finalPath;
try {
  finalPath = await executeBackupOperation({
    outputDirectory: resolve(parsedArguments.outputDirectory),
    environment: postgresEnvironment(target),
    assertNotInterrupted: runner.assertNotInterrupted,
    runCommand(command, arguments_, environment, outputFileDescriptor) {
      return runner.run(command, arguments_, {
        env: environment,
        stdio: ["ignore", outputFileDescriptor, "inherit"],
      });
    },
  });
} finally {
  runner.dispose();
}
console.log(`PostgreSQL backup created: ${finalPath}`);

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
