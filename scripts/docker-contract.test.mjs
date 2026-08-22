import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

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
  assert.match(dockerfile, /FROM gateway AS default\s*$/);
  assert.match(dockerfile, /headers:\{host:process\.env\.CONTROL_HOST/);
  assert.match(dockerfile, /FROM postgres-tools AS db-backup[\s\S]*ENTRYPOINT \["node", "scripts\/postgres-backup\.mjs"\]/);
  assert.match(dockerfile, /FROM postgres-tools AS db-restore[\s\S]*ENTRYPOINT \["node", "scripts\/postgres-restore\.mjs"\]/);
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
