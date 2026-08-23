import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationOperationBudget } from "./application-operation-budget.ts";

test("application operation budget은 DATA와 END가 공유할 connection 상한을 제공한다", () => {
  const budget = new ApplicationOperationBudget(2);
  const releaseData = budget.reserve();
  const releaseEnd = budget.reserve();

  assert.throws(() => budget.reserve(), /connection application operation limit/);
  releaseData();
  const releaseNext = budget.reserve();

  releaseData();
  releaseEnd();
  releaseNext();
});
