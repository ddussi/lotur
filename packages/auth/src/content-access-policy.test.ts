import assert from "node:assert/strict";
import test from "node:test";

import { canAccessSharedContent } from "./model.ts";

test("공유 화면 역할 정책은 reviewer와 developer만 허용한다", () => {
  assert.equal(canAccessSharedContent(["REVIEWER"]), true);
  assert.equal(canAccessSharedContent(["DEVELOPER"]), true);
  assert.equal(canAccessSharedContent(["ADMIN"]), false);
  assert.equal(canAccessSharedContent([]), false);
});
