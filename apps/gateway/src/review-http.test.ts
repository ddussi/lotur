import assert from "node:assert/strict";
import { test } from "node:test";

import type { Principal } from "../../../packages/auth/src/index.ts";
import { REVIEW_BOOTSTRAP_SOURCE } from "./review-bootstrap.ts";
import { createRefreshCoordinator } from "./review-ui/page-state.ts";
import { createReviewEventAdmission, reviewActorFromPrincipal } from "./review-http.ts";

test("review SSE admission counts pending opens and releases each slot once", () => {
  const admission = createReviewEventAdmission({
    maxConnections: 2,
    maxConnectionsPerAccount: 1,
  });
  const releaseOne = admission.tryAcquire("account-one");
  assert.notEqual(releaseOne, undefined);
  assert.equal(admission.tryAcquire("account-one"), undefined);
  const releaseTwo = admission.tryAcquire("account-two");
  assert.notEqual(releaseTwo, undefined);
  assert.equal(admission.tryAcquire("account-three"), undefined);

  releaseOne?.();
  releaseOne?.();
  const releaseThree = admission.tryAcquire("account-three");
  assert.notEqual(releaseThree, undefined);
  assert.equal(admission.tryAcquire("account-one"), undefined);

  releaseTwo?.();
  releaseThree?.();
  assert.notEqual(admission.tryAcquire("account-one"), undefined);
});

test("review capabilities are explicitly derived from authenticated account roles", () => {
  const base: Principal = {
    accountId: "account-one",
    authVersion: 7,
    username: "account-one",
    displayName: "Account One",
    roles: ["REVIEWER"],
    mustChangePassword: false,
    sessionId: "session-one",
  };
  assert.deepEqual(reviewActorFromPrincipal(base), {
    accountId: "account-one",
    username: "account-one",
    authorizationVersion: 7,
    displayName: "Account One",
    capabilities: {
      canRead: true,
      canComment: true,
      canManageProject: false,
    },
  });
  assert.deepEqual(reviewActorFromPrincipal({ ...base, roles: ["DEVELOPER"] }).capabilities, {
    canRead: true,
    canComment: true,
    canManageProject: true,
  });
  assert.deepEqual(reviewActorFromPrincipal({ ...base, roles: ["ADMIN"] }).capabilities, {
    canRead: false,
    canComment: false,
    canManageProject: false,
  });
});

test("review bootstrap is a self-contained browser script", () => {
  assert.doesNotThrow(() => new Function(REVIEW_BOOTSTRAP_SOURCE));
  assert.doesNotMatch(REVIEW_BOOTSTRAP_SOURCE, /\.innerHTML\s*=/);
});

test("review refresh bursts use one in-flight load and one dirty follow-up", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const requestLoad = createRefreshCoordinator(() => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve) => releases.push(() => {
      active -= 1;
      resolve();
    }));
  });

  const burst = Array.from({ length: 20 }, () => requestLoad());
  assert.equal(calls, 1);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  releases.shift()?.();
  await Promise.all(burst);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});
