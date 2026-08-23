import assert from "node:assert/strict";
import test from "node:test";

import { RetiredDataBudget, RetiredDataBudgetError } from "./retired-data-budget.ts";

test("retired DATA byte 허용량은 local reset credit으로만 채우고 connection lifetime 상한을 넘지 않는다", () => {
  const budget = new RetiredDataBudget(4, 8);
  assert.throws(() => budget.consume(1, 1), RetiredDataBudgetError);

  budget.allow(1, 3);
  assert.throws(() => budget.consume(3, 1), RetiredDataBudgetError);
  budget.consume(1, 3);
  budget.allow(3, 10);
  budget.consume(3, 1);
  assert.throws(() => budget.consume(3, 1), RetiredDataBudgetError);
});

test("retired DATA는 byte와 별개인 generation frame 상한도 소진한다", () => {
  const budget = new RetiredDataBudget(10, 2);
  budget.allow(1, 10);
  budget.consume(1, 1);
  budget.consume(1, 1);
  assert.throws(() => budget.consume(1, 1), /frame budget/);
});

test("사용되지 않은 오래된 allowance는 최신 local-reset race를 가로막지 않는다", () => {
  const budget = new RetiredDataBudget(10, 2);
  budget.allow(1, 1);
  budget.allow(3, 1);

  budget.allow(5, 1);
  budget.consume(5, 1);

  assert.throws(() => budget.consume(1, 1), RetiredDataBudgetError);
});
