import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const databaseUrl = required("RESTORE_DATABASE_URL");
const inputPath = resolve(requiredOption("--input"));
await access(inputPath);
const target = new URL(databaseUrl);
const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));
if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
  throw new Error("RESTORE_DATABASE_URL must use postgres:// or postgresql://");
}
if (databaseName === "" || ["postgres", "template0", "template1"].includes(databaseName)) {
  throw new Error("refusing to restore into a default PostgreSQL database");
}
const targetConfirmation = `${target.hostname}:${target.port || "5432"}/${databaseName}`;
if (process.env.CONFIRM_RESTORE_TARGET !== targetConfirmation) {
  throw new Error(`set CONFIRM_RESTORE_TARGET exactly to ${targetConfirmation}`);
}

await run("pg_restore", [
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-acl",
  "--exit-on-error",
  "--dbname",
  databaseName,
  inputPath,
], postgresEnvironment(target));
console.log(`PostgreSQL restore completed for ${targetConfirmation}`);

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function postgresEnvironment(targetUrl) {
  const environment = { ...process.env };
  delete environment.PGSERVICE;
  delete environment.PGSERVICEFILE;
  environment.PGHOST = targetUrl.hostname;
  environment.PGPORT = targetUrl.port || "5432";
  environment.PGDATABASE = decodeURIComponent(targetUrl.pathname.replace(/^\//, ""));
  environment.PGUSER = decodeURIComponent(targetUrl.username);
  environment.PGPASSWORD = decodeURIComponent(targetUrl.password);
  const supportedParameters = new Map([
    ["sslmode", "PGSSLMODE"],
    ["sslrootcert", "PGSSLROOTCERT"],
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
    ["connect_timeout", "PGCONNECT_TIMEOUT"],
    ["target_session_attrs", "PGTARGETSESSIONATTRS"],
    ["application_name", "PGAPPNAME"],
  ]);
  for (const [name, value] of targetUrl.searchParams) {
    const environmentName = supportedParameters.get(name);
    if (environmentName === undefined) {
      throw new Error(`unsupported RESTORE_DATABASE_URL parameter: ${name}`);
    }
    environment[environmentName] = value;
  }
  return environment;
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
