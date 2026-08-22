import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationalStateCache,
  parseDeploymentIdentity,
  type OperationalState,
} from "./operational-state.ts";

const identity = parseDeploymentIdentity(
  "release-42",
  `sha256:${"a".repeat(64)}`,
);

function state(overrides: Partial<OperationalState> = {}): OperationalState {
  return {
    identity,
    killSwitchEnabled: false,
    canaryStatus: "PASSED",
    canaryCheckedAt: new Date("2026-08-24T01:00:00.000Z"),
    admissionApprovedAt: new Date("2026-08-24T01:01:00.000Z"),
    admissionApprovedBy: "admin-1",
    updatedAt: new Date("2026-08-24T01:01:00.000Z"),
    ...overrides,
  };
}

test("admission은 같은 배포의 canary 성공과 명시적 승인 및 DB 가용성을 모두 요구한다", () => {
  const cache = new OperationalStateCache(identity);
  assert.equal(cache.isAdmissionReady(), false);
  assert.equal(cache.isKillSwitchEnabled(), true);

  cache.apply(state());
  assert.equal(cache.isAdmissionReady(), true);
  assert.equal(cache.isKillSwitchEnabled(), false);

  cache.markUnavailable();
  assert.equal(cache.isAdmissionReady(), false);
  assert.equal(cache.isKillSwitchEnabled(), false);
});

test("kill switch와 canary 실패는 승인 기록이 있어도 admission을 닫는다", () => {
  const cache = new OperationalStateCache(identity);
  cache.apply(state({ killSwitchEnabled: true }));
  assert.equal(cache.isAdmissionReady(), false);
  assert.equal(cache.isKillSwitchEnabled(), true);

  cache.apply(state({ canaryStatus: "FAILED" }));
  assert.equal(cache.isAdmissionReady(), false);
});

test("배포 식별자는 bounded ID와 canonical sha256 digest만 허용한다", () => {
  assert.deepEqual(identity, {
    deploymentId: "release-42",
    configDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.throws(() => parseDeploymentIdentity("", identity.configDigest), /DEPLOYMENT_ID/);
  assert.throws(() => parseDeploymentIdentity("release", "abc"), /DEPLOYMENT_CONFIG_DIGEST/);
});
