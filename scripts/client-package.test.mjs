import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);

test("standalone Client archive installs offline outside the repository with only its bundled runtime", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "review-tunnel-client-consumer-"));
  try {
    const output = join(temporary, "archives"), consumer = join(temporary, "consumer");
    await mkdir(consumer);
    const environment = {
      PATH: process.env.PATH, HOME: temporary, npm_config_cache: join(temporary, "empty-cache"),
      npm_config_userconfig: join(temporary, "empty-npmrc"), npm_config_globalconfig: join(temporary, "empty-global-npmrc"),
      npm_config_audit: "false", npm_config_fund: "false", npm_config_registry: "http://127.0.0.1:1",
    };
    await writeFile(environment.npm_config_userconfig, ""); await writeFile(environment.npm_config_globalconfig, "");
    const { stdout: packed } = await execute(process.execPath, ["scripts/pack-client.mjs", "--output-dir", output], { cwd: root, env: environment });
    const archive = packed.trim();
    const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
    assert.equal(archive, join(output, `review-tunnel-client-${version}.tgz`));
    const { stdout: entries } = await execute("tar", ["-tzf", archive]);
    const files = entries.trim().split("\n");
    assert.ok(files.includes("package/node_modules/ws/LICENSE"));
    assert.ok(files.includes("package/THIRD_PARTY_NOTICES.md"));
    assert.ok(files.every(file => /^(package\/(LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|package\.json|bin\/review-tunnel\.mjs|dist\/client\.mjs)|package\/node_modules\/ws\/(LICENSE|README\.md|package\.json|browser\.js|index\.js|wrapper\.mjs|lib\/[a-z-]+\.js))$/.test(file)), entries);
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "standalone-client-consumer", private: true, type: "module" }));
    await execute("npm", ["install", "--offline", "--ignore-scripts", archive], { cwd: consumer, env: environment });
    const installation = join(consumer, "node_modules/@review-tunnel/client");
    assert.equal((await lstat(installation)).isSymbolicLink(), false);
    const manifest = JSON.parse(await readFile(join(installation, "package.json"), "utf8"));
    assert.equal(manifest.version, version);
    assert.deepEqual(manifest.bundledDependencies, ["ws"]);
    assert.deepEqual(Object.keys(manifest.dependencies), ["ws"]);
    assert.equal(manifest.scripts, undefined);
    assert.equal(await readFile(join(installation, "LICENSE"), "utf8"), await readFile(join(root, "LICENSE"), "utf8"));
    const bundledWsLicense = await readFile(join(installation, "node_modules/ws/LICENSE"), "utf8");
    assert.ok((await readFile(join(installation, "THIRD_PARTY_NOTICES.md"), "utf8")).includes(bundledWsLicense));
    const bundle = await readFile(join(installation, "dist/client.mjs"), "utf8");
    assert.equal(bundle.includes(root), false);
    const cli = join(consumer, "node_modules/.bin/review-tunnel");
    for (const args of [["--help"], ["--version"]]) {
      const result = await execute(cli, args, { cwd: consumer, env: environment });
      assert.equal(result.stderr, "");
      if (args[0] === "--version") assert.equal(result.stdout.trim(), version);
      else assert.match(result.stdout, /Usage: review-tunnel/);
    }
    const invalid = await execute(cli, ["--unknown"], { cwd: consumer, env: environment }).then(() => undefined, error => error);
    assert.equal(invalid?.code, 1); assert.match(invalid.stderr, /Usage: review-tunnel/);
    assert.doesNotMatch(invalid.stderr, /\n\s+at /);
    const origin = createServer(socket => socket.end());
    await new Promise((resolve, reject) => {
      origin.once("error", reject);
      origin.listen(0, "127.0.0.1", resolve);
    });
    const shareArgs = [`http://127.0.0.1:${origin.address().port}`, "--gateway", "ws://control.localhost:8788/_review-tunnel/carrier", "--username", "developer"];
    try {
      const needsTty = await execute(cli, shareArgs, { cwd: consumer, env: environment }).then(() => undefined, error => error);
      assert.equal(needsTty?.code, 1); assert.match(needsTty.stderr, /TTY is required/);
    } finally {
      await new Promise((resolve, reject) => origin.close(error => error ? reject(error) : resolve()));
    }
    const needsOrigin = await execute(cli, shareArgs, { cwd: consumer, env: environment }).then(() => undefined, error => error);
    assert.equal(needsOrigin?.code, 1);
    assert.match(needsOrigin.stderr, /로컬 웹앱을 먼저 실행/);
    assert.doesNotMatch(needsOrigin.stderr, /TTY is required/);
    const again = await execute(process.execPath, ["scripts/pack-client.mjs", "--output-dir", output], { cwd: root, env: environment }).then(() => undefined, error => error);
    assert.equal(again?.code, 1); assert.match(again.stderr, /already exists/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
