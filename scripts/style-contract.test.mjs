import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("코드 품질 검사는 고정된 Biome lint 설정으로 완료 게이트에 포함된다", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const configuration = JSON.parse(await readFile(new URL("biome.json", root), "utf8"));

  assert.equal(manifest.devDependencies?.["@biomejs/biome"], "2.5.11");
  assert.equal(manifest.scripts?.["check:style"], "biome lint .");
  assert.match(manifest.scripts?.check ?? "", /^npm run check:style && /);
  assert.equal(configuration.formatter?.enabled, false);
  assert.equal(configuration.assist?.enabled, false);
  assert.equal(configuration.linter?.rules?.preset, "recommended");
  assert.equal(configuration.linter?.rules?.complexity?.useOptionalChain, "off");
  assert.equal(configuration.linter?.rules?.style?.noNonNullAssertion, "off");
  assert.equal(configuration.vcs?.useIgnoreFile, true);
  for (const ignored of [
    "!!**/dist",
    "!!**/.next",
    "!!test-results",
    "!!coverage",
    "!!tests/frameworks/.runtime-*",
  ]) assert.ok(configuration.files?.includes?.includes(ignored), `missing ignore: ${ignored}`);
});
