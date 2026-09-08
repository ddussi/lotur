import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";

const root = fileURLToPath(new URL("../..", import.meta.url));
const execute = promisify(execFile);
async function ports() {
  const reservations = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const server = createServer();
      server.listen(0, "127.0.0.1"); await once(server, "listening"); reservations.push(server);
    }
    return reservations.map(server => server.address().port);
  } finally { await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve)))); }
}
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-demo-browser-"));
  const [databasePort, gatewayPort, appPort] = await ports();
  const args = ["scripts/demo.mjs", "--state-dir", directory, "--database-port", String(databasePort), "--gateway-port", String(gatewayPort), "--app-port", String(appPort)];
  let current;
  async function stop(signal = "SIGTERM") {
    if (!current || current.child.exitCode !== null || current.child.signalCode !== null) return;
    current.child.kill(signal);
    let timer;
    try { await Promise.race([current.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Demo did not stop")), 30_000); })]); }
    finally { clearTimeout(timer); }
  }
  async function start({ waitUntilReady = true } = {}) {
    let output = "";
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    current = { child, closed: once(child, "exit"), output: () => output };
    if (!waitUntilReady) return current;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Demo exited: ${output}`);
      try {
        const ready = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
        const accounts = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"));
        return { ...ready, accounts };
      } catch {}
      await delay(100);
    }
    throw new Error(`Demo did not become ready: ${output}`);
  }
  async function inspectDatabase() {
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    const pool = new Pool({ connectionString: `postgres://demo_runtime:${config.runtimePassword}@127.0.0.1:${databasePort}/review_tunnel_demo` });
    try {
      return {
        threads: (await pool.query("SELECT id, body, status, workflow_version, anchor FROM rt_review_threads ORDER BY id")).rows,
        replies: (await pool.query("SELECT id, thread_id, body FROM rt_review_replies ORDER BY id")).rows,
        notifications: (await pool.query("SELECT id, recipient_account_id, reason FROM rt_review_notifications ORDER BY id")).rows,
      };
    } finally { await pool.end(); }
  }
  async function close() {
    try { await stop(); }
    finally {
      const reset = await execute(process.execPath, ["scripts/demo.mjs", "reset", "--state-dir", directory, "--confirm-delete-demo-data"], { cwd: root });
      assert.match(reset.stdout, /deleted/);
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { directory, args, start, stop, inspectDatabase, close, current: () => current };
}
export async function login(page, url, account) {
  await page.goto(url);
  if (new URL(page.url()).pathname === "/login") {
    await page.getByLabel("아이디", { exact: true }).fill(account.username);
    await page.getByLabel("비밀번호", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
  }
}

