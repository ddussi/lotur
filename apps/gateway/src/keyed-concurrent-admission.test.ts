import assert from "node:assert/strict";
import test from "node:test";

import { createKeyedConcurrentAdmission } from "./keyed-concurrent-admission.ts";

test("keyed admission은 global·key별 상한과 idempotent release를 함께 지킨다", () => {
  const admission = createKeyedConcurrentAdmission({ global: 2, perKey: 1 });

  const releaseFirst = admission.acquire("first");
  assert.ok(releaseFirst);
  assert.equal(admission.acquire("first"), undefined);

  const releaseSecond = admission.acquire("second");
  assert.ok(releaseSecond);
  assert.equal(admission.acquire("third"), undefined);

  releaseFirst();
  releaseFirst();
  const releaseThird = admission.acquire("third");
  assert.ok(releaseThird);

  releaseSecond();
  releaseThird();
});
