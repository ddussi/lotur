import assert from "node:assert/strict";
import test from "node:test";

import { resumeOwnerAuthorizationMatches } from "./resume-authorization.ts";

test("resume owner는 account id와 authVersion이 모두 정확히 일치해야 한다", () => {
  const owner = { accountId: "account-1", accountAuthVersion: 7 };

  assert.equal(resumeOwnerAuthorizationMatches(owner, owner), true);
  assert.equal(resumeOwnerAuthorizationMatches(owner, {
    accountId: "account-2",
    accountAuthVersion: 7,
  }), false);
  assert.equal(resumeOwnerAuthorizationMatches(owner, {
    accountId: "account-1",
    accountAuthVersion: 8,
  }), false);
  assert.equal(resumeOwnerAuthorizationMatches(owner, undefined), false);
  assert.equal(resumeOwnerAuthorizationMatches(undefined, undefined), true);
});
