import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectModuleSpecifiers } from "./check-boundaries-lib.mjs";

const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Docker image는 상주 Gateway와 one-off 역할을 별도 target으로 고정한다", () => {
  for (const target of [
    "gateway",
    "admin-cli",
    "client",
    "canary-check",
  ]) {
    assert.match(dockerfile, new RegExp(`FROM runtime-user AS ${target}\\b`));
  }

  assert.match(dockerfile, /FROM runtime-files AS runtime-user\s+USER node/);
  assert.match(dockerfile, /FROM runtime-user AS gateway[\s\S]*CMD \["node", "dist\/apps\/gateway\/src\/main\.js"\]/);
  assert.match(dockerfile, /FROM runtime-user AS admin-cli[\s\S]*ENTRYPOINT \["node", "dist\/apps\/admin-cli\/src\/main\.js"\]/);
  assert.match(dockerfile, /FROM runtime-user AS client[\s\S]*ENTRYPOINT \["node", "dist\/apps\/client\/src\/main\.js"\]/);
  assert.match(dockerfile, /FROM runtime-user AS canary-check[\s\S]*ENTRYPOINT \["node", "scripts\/verify-public-path\.mjs"\]/);
  assert.match(
    dockerfile,
    /FROM runtime-user AS canary-check[\s\S]*canary-policy\.mjs/,
    "canary image must include every local module imported by its entrypoint",
  );
  assert.match(dockerfile, /FROM gateway AS default\s*$/);
  assert.match(
    dockerfile,
    /headers:\{host:process\.env\.CONTROL_HOST\|\|'control\.'\+\(process\.env\.CONTENT_DOMAIN\|\|'localhost'\)\}/,
    "Gateway health probe fallback must use the server's derived control hostname",
  );
  assert.match(dockerfile, /FROM postgres-tools AS db-backup[\s\S]*ENTRYPOINT \["node", "scripts\/postgres-backup\.mjs"\]/);
  assert.match(dockerfile, /FROM postgres-tools AS db-restore[\s\S]*ENTRYPOINT \["node", "scripts\/postgres-restore\.mjs"\]/);
  assert.match(
    dockerfile,
    /FROM postgres:17\.6-bookworm[\s\S]*postgres-operations\.mjs[\s\S]*postgres-process\.mjs/,
    "PostgreSQL tool images must include every shared module imported by their entrypoints",
  );
});

test("운영 image base는 floating tag가 아니라 digest로 고정한다", () => {
  const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM node:"));
  assert.ok(fromLines.length >= 2);
  for (const line of fromLines) assert.match(line, /@sha256:[a-f0-9]{64}\b/);
  assert.match(
    dockerfile,
    /FROM postgres:17\.6-bookworm@sha256:[a-f0-9]{64} AS postgres-tools/,
  );
});

test("script runtime stage는 entrypoint의 transitive local module closure를 모두 복사한다", async () => {
  const stageEntrypoints = new Map([
    ["canary-check", ["scripts/verify-public-path.mjs"]],
    ["postgres-tools", [
      "scripts/postgres-backup.mjs",
      "scripts/postgres-restore.mjs",
    ]],
  ]);

  for (const [stage, entrypoints] of stageEntrypoints) {
    const stageSource = dockerStage(stage);
    const closure = await localModuleClosure(entrypoints);
    for (const modulePath of closure) {
      assert.ok(
        stageSource.includes(`/app/${modulePath} ./${modulePath}`),
        `${stage} must copy ${modulePath}`,
      );
    }
  }
});

function dockerStage(stage) {
  const marker = new RegExp(`^FROM .+ AS ${stage}$`, "m");
  const match = marker.exec(dockerfile);
  assert.notEqual(match, null, `missing Docker stage ${stage}`);
  const start = match.index;
  const next = dockerfile.indexOf("\nFROM ", start + match[0].length);
  return dockerfile.slice(start, next < 0 ? undefined : next);
}

async function localModuleClosure(entrypoints) {
  const pending = [...entrypoints];
  const visited = new Set();
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (visited.has(modulePath)) continue;
    visited.add(modulePath);
    const absolutePath = resolve(workspaceRoot, modulePath);
    const source = await readFile(absolutePath, "utf8");
    for (const specifier of collectModuleSpecifiers(source, absolutePath)) {
      if (!specifier.startsWith(".")) continue;
      const dependency = relative(
        workspaceRoot,
        resolve(dirname(absolutePath), specifier),
      ).split(sep).join("/");
      pending.push(dependency);
    }
  }
  return visited;
}
