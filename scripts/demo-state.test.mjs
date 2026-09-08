import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { prepareDirectory, acquireLock, loadOrCreateConfig, validateConfig, parseArguments, credentials } from "./demo/state.mjs";
import { cleanEnvironment } from "./demo/processes.mjs";

async function directory(context) {
  const root = await mkdtemp(join(tmpdir(), "review-tunnel-demo-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("demo state persists generated credentials with private permissions and rejects unsafe port changes", async context => {
  const root = await directory(context);
  await prepareDirectory(root);
  const first = await loadOrCreateConfig(root, {});
  assert.deepEqual(await loadOrCreateConfig(root, {}), first);
  assert.equal((await stat(join(root, "config.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal(new Set(Object.values(first.passwords)).size, 3);
  assert.deepEqual(Object.keys(credentials(first)), ["developer", "reviewer"]);
  await assert.rejects(loadOrCreateConfig(root, { gatewayPort: first.appPort }), /configured ports/);
  assert.throws(() => validateConfig({ ...first, appPort: first.gatewayPort }), /must differ/);
  assert.throws(() => validateConfig({ ...first, runtimePassword: "injected' SQL" }), /credentials/);
});

test("demo setup preserves an unrelated directory and config file", async context => {
  const root = await directory(context);
  await writeFile(join(root, "config.json"), '{"otherApplication":true}');
  await writeFile(join(root, "keep.txt"), "keep me");
  await assert.rejects(prepareDirectory(root), /Unrecognized demo state/);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep me");
});

test("demo locking rejects an active owner and recovers only after the recorded process exits", async context => {
  const root = await directory(context);
  const release = await acquireLock(root);
  await assert.rejects(acquireLock(root), /already using/);
  await release();
  const deadPid = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }));
  await writeFile(join(root, "run.lock"), JSON.stringify({ pid: deadPid, token: "finished-test-process" }));
  const releaseRecovered = await acquireLock(root);
  const otherOwner = JSON.stringify({ pid: process.pid, token: "another-owner" });
  await writeFile(join(root, "run.lock"), otherOwner);
  await releaseRecovered();
  assert.equal(await readFile(join(root, "run.lock"), "utf8"), otherOwner);
});

test("demo options and child environments cannot inherit production database or Node startup configuration", () => {
  const environment = cleanEnvironment({ PATH: "/test/bin", HOME: "/test/home", DATABASE_URL: "production", GATEWAY_HOST: "0.0.0.0", NODE_OPTIONS: "--inspect", ALLOW_INSECURE_POC: "true" });
  assert.deepEqual(environment, { PATH: "/test/bin", HOME: "/test/home" });
  assert.throws(() => parseArguments(["--database-port", "5432;delete"], "/repo"), /Invalid port/);
  assert.throws(() => parseArguments(["--state-dir", "/repo"], "/repo"), /separate directory/);
  assert.throws(() => parseArguments(["--confirm-delete-demo-data"], "/repo"), /only to reset/);
  assert.equal(parseArguments(["reset", "--confirm-delete-demo-data"], "/repo").confirmReset, true);
});
