import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CI는 실제 PostgreSQL과 framework를 포함한 완료 게이트를 실행한다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /services:\s*\n\s+postgres:/);
  assert.match(workflow, /image: postgres:17\.11-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(workflow, /TEST_DATABASE_URL:/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check:mvp/);
  assert.match(workflow, /playwright install --with-deps chrome/);
  assert.match(workflow, /npm audit --omit=dev/);
  assert.match(workflow, /node scripts\/verified-images-cli.mjs build/);
  assert.equal((workflow.match(/verified-images-cli.mjs build/g) || []).length, 1);
  assert.doesNotMatch(workflow, /docker build/);
  assert.ok(workflow.indexOf('verified-images-cli.mjs seal') > workflow.indexOf('npm run test:restore'));
  assert.match(workflow, /gh run download/);
  assert.match(workflow, /verified-images-cli.mjs publish/);
  assert.match(workflow, /expect_failure "DATABASE_URL is required" docker run --rm/);
  assert.match(workflow, /runtime failed for an unexpected reason/);
  assert.match(workflow, /RESTORE_TEST_IMAGE_TAG: ci/);
  assert.ok(workflow.indexOf("npm run test:restore") > workflow.indexOf("Smoke runtime entrypoints"));
  assert.ok(workflow.indexOf("npm run test:restore") < workflow.indexOf("npm run pack:release"));
  assert.match(workflow, /path: test-results\/restore\/\*\*\/restore-validation\.json/);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7\.0\.1/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7\.0\.0/,
  );
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node)@v\d+/);
});
