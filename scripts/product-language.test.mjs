import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productTextFiles = [
  "../README.md",
  "../README.ko.md",
  "../.env.example",
  "../docs/getting-started.md",
  "../docs/internal-account-operations.md",
  "../docs/linux-deployment.md",
  "../docs/poc-status.md",
  "../docs/review-tunnel-plan.md",
  "../docs/adr/0001-typescript-runtime.md",
  "../docs/adr/0003-internal-account-auth.md",
  "../apps/gateway/src/main.ts",
  "../apps/gateway/src/web-auth-pages.ts",
];

const forbiddenOrganizationAssumptions = new RegExp(
  `${"회" + "사"}|${"사" + "내"}|\\b${"comp" + "any"}\\b|\\b${"corpo" + "rate"}\\b`,
  "i",
);

test("제품 설명과 사용자 노출 문구는 특정 운영 주체를 전제로 하지 않는다", async () => {
  for (const relativePath of productTextFiles) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, forbiddenOrganizationAssumptions, relativePath);
  }
});
