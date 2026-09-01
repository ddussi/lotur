import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  collectModuleSpecifiers,
  resolveImportTarget,
} from "./check-boundaries-lib.mjs";

const execFileAsync = promisify(execFile);

test("boundary parser는 side-effect, export, dynamic import와 TSX를 모두 읽는다", () => {
  const source = `
    import "../../../apps/gateway/src/main.ts";
    export * from "../protocol/src/index.ts";
    const module = await import("@review-tunnel/auth");
    const view = <div />;
  `;

  assert.deepEqual(collectModuleSpecifiers(source, "fixture.tsx"), [
    "../../../apps/gateway/src/main.ts",
    "../protocol/src/index.ts",
    "@review-tunnel/auth",
  ]);
});

test("boundary parser는 import type expression과 CommonJS loader도 읽는다", () => {
  const source = `
    import { createRequire } from "node:module";
    type Account = import("@review-tunnel/auth").Account;
    const direct = require("@review-tunnel/gateway");
    const load = createRequire(import.meta.url);
    const indirect = load("@review-tunnel/client");
  `;

  assert.deepEqual(collectModuleSpecifiers(source, "fixture.ts"), [
    "node:module",
    "@review-tunnel/auth",
    "@review-tunnel/gateway",
    "@review-tunnel/client",
  ]);
});

test("boundary parser는 module.require와 namespace createRequire도 읽는다", () => {
  const source = `
    import * as moduleTools from "node:module";
    const direct = module.require("@review-tunnel/gateway");
    const load = moduleTools.createRequire(import.meta.url);
    const indirect = load("@review-tunnel/client");
  `;

  assert.deepEqual(collectModuleSpecifiers(source, "fixture.ts"), [
    "node:module",
    "@review-tunnel/gateway",
    "@review-tunnel/client",
  ]);
});

test("boundary parser는 CommonJS로 불러온 createRequire alias도 추적한다", () => {
  const source = `
    const { createRequire: makeRequire } = require("node:module");
    const moduleTools = require("module");
    const firstLoad = makeRequire(import.meta.url);
    const secondLoad = moduleTools.createRequire(import.meta.url);
    firstLoad("@review-tunnel/gateway");
    secondLoad("@review-tunnel/client");
  `;

  assert.deepEqual(collectModuleSpecifiers(source, "fixture.ts"), [
    "node:module",
    "module",
    "@review-tunnel/gateway",
    "@review-tunnel/client",
  ]);
});

test("workspace alias는 실제 package source로 해석한다", () => {
  const workspaceDirectories = new Map([
    ["@review-tunnel/auth", "/repo/packages/auth"],
    ["@review-tunnel/new-dashboard", "/repo/apps/new-dashboard"],
  ]);
  assert.equal(
    resolveImportTarget(
      "/repo/apps/client/src/main.ts",
      "@review-tunnel/auth",
      workspaceDirectories,
    ),
    "/repo/packages/auth/src/index.ts",
  );
  assert.equal(
    resolveImportTarget(
      "/repo/packages/protocol/src/index.ts",
      "node:crypto",
      workspaceDirectories,
    ),
    undefined,
  );
  assert.equal(
    resolveImportTarget(
      "/repo/packages/auth/src/index.ts",
      "@review-tunnel/new-dashboard",
      workspaceDirectories,
    ),
    "/repo/apps/new-dashboard/src/index.ts",
  );
  assert.throws(
    () => resolveImportTarget(
      "/repo/packages/auth/src/index.ts",
      "@review-tunnel/typo",
      workspaceDirectories,
    ),
    /unknown workspace package/,
  );
});

test("boundary CLI는 temp workspace의 실제 loader 위반을 non-zero로 거부한다", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "review-tunnel-boundary-cli-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true }));
  });
  await writeWorkspace(root, "apps", "gateway", "@review-tunnel/gateway", "export {};\n");
  await writeWorkspace(
    root,
    "packages",
    "auth",
    "@review-tunnel/auth",
    `
      import * as moduleTools from "node:module";
      const load = moduleTools.createRequire(import.meta.url);
      load("@review-tunnel/gateway");
    `,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url)),
      "--root",
      root,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /packages\/auth\/src\/index\.ts must not depend on apps\/gateway/);
      return true;
    },
  );
});

async function writeWorkspace(root, group, directoryName, packageName, source) {
  const directory = join(root, group, directoryName);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: packageName }));
  await writeFile(join(directory, "src", "index.ts"), source);
}

test("proxy·operations와 순수 변경 정책에 인프라 의존을 추가할 수 없다", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "review-tunnel-policy-boundary-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true }));
  });
  await writeWorkspace(root, "apps", "gateway", "@review-tunnel/gateway", "export {};\n");
  await writeWorkspace(root, "packages", "auth", "@review-tunnel/auth", "export {};\n");
  await writeWorkspace(root, "packages", "proxy", "@review-tunnel/proxy", 'import "@review-tunnel/auth";\n');
  await writeWorkspace(root, "packages", "operations", "@review-tunnel/operations", 'import "@review-tunnel/proxy";\n');
  await writeWorkspace(root, "packages", "review", "@review-tunnel/review", "export {};\n");
  await writeFile(join(root, "packages/review/src/content-mutation-policy.ts"), 'import "node:fs";\n');
  await assert.rejects(execFileAsync(process.execPath, [
    fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url)), "--root", root,
  ]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /proxy core must not depend on/);
    assert.match(error.stderr, /operations core must not depend on/);
    assert.match(error.stderr, /pure policy must not import node:fs/);
    return true;
  });
});
