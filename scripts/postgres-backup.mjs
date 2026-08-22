import { spawn } from "node:child_process";
import { mkdir, chmod, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { parsePostgresTarget, postgresEnvironment } from "./postgres-url.mjs";

const databaseUrl = required("DATABASE_URL");
const { target } = parsePostgresTarget(databaseUrl, "DATABASE_URL");
const outputDirectory = resolve(option("--output-dir") ?? "backups");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const finalPath = `${outputDirectory}/review-tunnel-${timestamp}.dump`;
const temporaryPath = `${finalPath}.partial`;

try {
  await run("pg_dump", [
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file",
    temporaryPath,
  ], postgresEnvironment(target));
  const information = await stat(temporaryPath);
  if (information.size === 0) throw new Error("pg_dump produced an empty backup");
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, finalPath);
  console.log(`PostgreSQL backup created: ${finalPath}`);
} catch (error) {
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function run(command, arguments_, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
    });
  });
}
