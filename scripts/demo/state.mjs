import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";

const FORMAT = "review-tunnel-demo-v1";
export const stateFiles = ["config.json", "accounts.json", "ready.json", "runner.log"];
const secret = () => randomBytes(32).toString("base64url");
export const credentials = config => Object.fromEntries(
  ["developer", "reviewer"].map(username => [username, {
    username, password: config.passwords[username],
  }]),
);

export async function writePrivate(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`, {
      flag: "wx", mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Demo state must be a real directory.");
  const entries = await readdir(directory);
  if (entries.length && !entries.includes("config.json") && !entries.includes("run.lock")) {
    throw new Error("Choose an empty directory for demo state; existing unrelated files were preserved.");
  }
  if (entries.includes("config.json")) await loadConfig(directory);
  await chmod(directory, 0o700);
}

export function validateConfig(config) {
  if (config?.format !== FORMAT || !/^[a-f0-9]{12}$/.test(config.id ?? "")) {
    throw new Error("Unrecognized demo state. Its files and database were preserved.");
  }
  for (const field of ["databasePort", "gatewayPort", "appPort"]) {
    if (!Number.isInteger(config[field]) || config[field] < 1024 || config[field] > 65535) {
      throw new Error(`Invalid demo ${field}; use a port from 1024 to 65535.`);
    }
  }
  if (new Set([config.databasePort, config.gatewayPort, config.appPort]).size !== 3) {
    throw new Error("Demo database, Gateway and app ports must differ.");
  }
  for (const value of [config.databasePassword, config.runtimePassword, config.hmacKey,
    config.canaryToken, config.metricsToken, ...Object.values(config.passwords ?? {})]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(value)) {
      throw new Error("Invalid generated demo credentials; existing data was preserved.");
    }
  }
  if (["admin", "developer", "reviewer"].some(name => !config.passwords?.[name])) {
    throw new Error("Demo account credentials are incomplete.");
  }
  return config;
}

export async function loadConfig(directory) {
  try { return validateConfig(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export async function loadOrCreateConfig(directory, ports) {
  const existing = await loadConfig(directory);
  if (existing) {
    for (const [field, value] of Object.entries(ports)) {
      if (value !== undefined && existing[field] !== value) {
        throw new Error("This demo already has configured ports. Choose another state directory for different ports.");
      }
    }
    return existing;
  }
  const config = validateConfig({
    format: FORMAT, id: randomBytes(6).toString("hex"),
    databasePort: ports.databasePort ?? 54339,
    gatewayPort: ports.gatewayPort ?? 8788,
    appPort: ports.appPort ?? 5178,
    databasePassword: secret(), runtimePassword: secret(), hmacKey: secret(),
    canaryToken: secret(), metricsToken: secret(),
    passwords: { admin: secret(), developer: secret(), reviewer: secret() },
    pendingPasswords: {},
  });
  await writePrivate(join(directory, "config.json"), config);
  return config;
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; return true; }
}

export async function acquireLock(directory) {
  const file = join(directory, "run.lock");
  const token = randomUUID();
  const owner = { pid: process.pid, token };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      return async () => {
        const current = await readFile(file, "utf8").catch(() => "");
        if (current === JSON.stringify(owner)) await unlink(file);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let current;
      try { current = JSON.parse(await readFile(file, "utf8")); }
      catch { throw new Error("Another demo is starting, or its lock is incomplete. Existing state was preserved."); }
      if (processAlive(current.pid)) throw new Error("A demo process is already using this state directory. Stop it with Ctrl+C first.");
      if (typeof current.token !== "string") throw new Error("Unrecognized demo lock; existing state was preserved.");
      // Never signal a PID from a saved file. Only a confirmed dead owner's lock is reclaimed.
      const stillCurrent = await readFile(file, "utf8").catch(() => "");
      if (stillCurrent === JSON.stringify(current)) await unlink(file).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  throw new Error("Another demo is claiming this state directory; retry after it finishes.");
}

export function parseArguments(arguments_, root) {
  let command = "start";
  const values = {};
  let confirmReset = false;
  const remaining = [...arguments_];
  if (remaining[0] && !remaining[0].startsWith("-")) command = remaining.shift();
  if (!["start", "reset", "credentials"].includes(command)) throw new Error("Use start, credentials, or reset. See --help.");
  const names = new Map([
    ["--state-dir", "directory"], ["--database-port", "databasePort"],
    ["--gateway-port", "gatewayPort"], ["--app-port", "appPort"],
  ]);
  while (remaining.length) {
    const flag = remaining.shift();
    if (flag === "--confirm-delete-demo-data" && !confirmReset) { confirmReset = true; continue; }
    const name = names.get(flag);
    const value = remaining.shift();
    if (!name || !value || value.startsWith("--") || values[name] !== undefined) throw new Error(`Invalid demo option: ${flag}. See --help.`);
    if (name !== "directory" && !/^\d+$/.test(value)) throw new Error(`Invalid port: ${flag}.`);
    values[name] = name === "directory" ? value : Number(value);
  }
  if (confirmReset && command !== "reset") throw new Error("The delete confirmation applies only to reset.");
  const directory = resolve(values.directory ?? join(root, ".review-tunnel-demo"));
  if (directory === resolve(root)) throw new Error("Use a separate directory for demo state.");
  return { command, directory, confirmReset, ports: {
    databasePort: values.databasePort, gatewayPort: values.gatewayPort, appPort: values.appPort,
  } };
}
