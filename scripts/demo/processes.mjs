import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export function cleanEnvironment(source = process.env) {
  return Object.fromEntries([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM",
    "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_CONFIG",
  ].filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

export function createProcesses({ root, environment, log, redact, signal }) {
  const active = new Set();
  function start(label, executable, arguments_, options = {}) {
    signal.throwIfAborted();
    const child = spawn(executable, arguments_, {
      cwd: root, env: options.environment ?? environment, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let failure;
    const finished = new Promise(resolve => {
      child.once("error", error => { failure = error; resolve({ code: null, error }); });
      child.once("close", (code, killedBy) => resolve({ code, killedBy, error: failure }));
    });
    const item = { child, finished, output: () => output, label };
    active.add(item);
    child.stdin.on("error", error => { if (error.code !== "EPIPE") failure = error; });
    child.stdout.on("data", bytes => {
      output = (output + bytes.toString()).slice(-1_048_576);
      if (options.logOutput !== false) log.write(`[${label}] ${redact(bytes.toString())}`);
    });
    child.stderr.on("data", bytes => log.write(`[${label}] ${redact(bytes.toString())}`));
    child.stdin.end(options.input);
    void finished.then(() => active.delete(item));
    return item;
  }
  async function stop(item) {
    if (item.child.exitCode !== null || item.child.signalCode !== null) return;
    item.child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([item.finished, new Promise(resolve => { timer = setTimeout(resolve, 4000); })]);
      if (item.child.exitCode === null && item.child.signalCode === null) {
        item.child.kill("SIGKILL");
        await item.finished;
      }
    } finally { clearTimeout(timer); }
  }
  async function run(label, executable, arguments_, options = {}) {
    const item = start(label, executable, arguments_, options);
    let timer;
    const aborted = () => { void stop(item); };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      const result = await Promise.race([
        item.finished,
        new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), options.timeoutMs ?? 90_000); }),
      ]);
      signal.throwIfAborted();
      if (result.timeout) { await stop(item); throw new Error(`${label} timed out. See the private runner log.`); }
      if (result.code !== 0 || result.error) {
        throw new Error(`${label} failed${result.error?.code ? ` (${result.error.code})` : ""}. See the private runner log.`);
      }
      return item.output();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
  }
  return { start, run, stop, stopAll: async () => {
    for (const item of [...active].reverse()) await stop(item);
  } };
}

export async function waitFor(check, label, { signal, processes = [], timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    for (const item of processes) {
      if (item.child.exitCode !== null || item.child.signalCode !== null) {
        throw new Error(`${item.label} exited before ${label}. See the private runner log.`);
      }
    }
    try { const result = await check(); if (result) return result; }
    catch (error) { if (signal.aborted) throw error; }
    await delay(150, undefined, { signal });
  }
  throw new Error(`${label} timed out. See the private runner log.`);
}

export async function requireFreePort(port, label) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", error => reject(new Error(`${label} port ${port} is unavailable (${error.code}). Stop that service or choose another demo port.`)));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, resolve);
  });
  await new Promise(resolve => server.close(resolve));
}
