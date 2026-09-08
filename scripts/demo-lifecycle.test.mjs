import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadOrCreateConfig } from "./demo/state.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
async function fixture(context, { remote = false, ports = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-demo-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state"), bin = join(directory, "bin");
  await mkdir(state); await mkdir(bin);
  const config = await loadOrCreateConfig(state, ports);
  const calls = join(directory, "docker-calls.jsonl");
  await writeFile(join(bin, "docker"), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'context') console.log(${JSON.stringify(remote ? "ssh://remote.invalid" : "unix:///local-test-only.sock")});
else if (args[0] === 'info') console.log('29.1.3');
else if (args[0] === 'compose' && args[1] === 'version') console.log('2.39.0');
else { console.error('Unexpected Docker mutation in failure test'); process.exitCode = 99; }
`, { mode: 0o700 });
  async function run(args = [], environment = {}) {
    return execute(process.execPath, ["scripts/demo.mjs", ...args, "--state-dir", state], {
      cwd: root, env: { PATH: bin, ...environment }, timeout: 15_000,
    }).then(result => ({ ...result, code: 0 }), error => error);
  }
  async function preserved() {
    assert.deepEqual(JSON.parse(await readFile(join(state, "config.json"), "utf8")), config);
    await assert.rejects(access(join(state, "run.lock")), { code: "ENOENT" });
    await assert.rejects(access(join(state, "ready.json")), { code: "ENOENT" });
  }
  return { directory, state, bin, calls, config, run, preserved };
}

test("demo reset requires explicit deletion intent before Docker is invoked", async context => {
  const demo = await fixture(context);
  const result = await demo.run(["reset"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--confirm-delete-demo-data/);
  await assert.rejects(access(demo.calls), { code: "ENOENT" });
  await demo.preserved();
});

test("demo rejects a remote Docker context without starting or stopping containers", async context => {
  const demo = await fixture(context, { remote: true });
  const result = await demo.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /local Docker socket/);
  const calls = (await readFile(demo.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args[0]), ["context"]);
  await demo.preserved();
});

test("missing Docker leaves generated state reusable and releases the lock", async context => {
  const demo = await fixture(context);
  const result = await demo.run([], { PATH: join(demo.directory, "missing-bin") });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Docker context failed \(ENOENT\)/);
  await demo.preserved();
});

test("demo port conflict preserves the existing listener and does not touch containers", async context => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  context.after(() => new Promise(resolve => listener.close(resolve)));
  const gatewayPort = listener.address().port;
  const demo = await fixture(context, { ports: { gatewayPort, appPort: gatewayPort === 5178 ? 5179 : 5178, databasePort: gatewayPort === 54339 ? 54340 : 54339 } });
  const result = await demo.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Gateway port .* unavailable \(EADDRINUSE\)/);
  assert.equal(listener.listening, true);
  const calls = (await readFile(demo.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [["context", "inspect"], ["info", "--format"], ["compose", "version"]]);
  await demo.preserved();
});
