import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAdminCommand } from "./arguments.ts";
import { adminCommandRuntimePolicy } from "./runtime-policy.ts";

test("bootstrap command requires username and display name", () => {
  assert.deepEqual(
    parseAdminCommand(["bootstrap", "--username", "admin", "--display-name", "운영 관리자"]),
    { kind: "bootstrap", username: "admin", displayName: "운영 관리자" },
  );
  assert.throws(() => parseAdminCommand(["bootstrap", "--username", "admin"]), /--display-name/);
});

test("create-user parses explicit actor and roles", () => {
  assert.deepEqual(
    parseAdminCommand([
      "create-user", "--as", "admin", "--username", "dev1", "--display-name", "Dev One",
      "--roles", "developer,reviewer", "--password-stdin",
    ]),
    {
      kind: "create-user",
      actorUsername: "admin",
      username: "dev1",
      displayName: "Dev One",
      roles: ["DEVELOPER", "REVIEWER"],
      passwordStdin: true,
    },
  );
});

test("unknown roles and commands fail closed", () => {
  assert.throws(
    () => parseAdminCommand([
      "set-roles", "--as", "admin", "--username", "dev1", "--roles", "OWNER",
    ]),
    /Invalid roles/,
  );
  assert.throws(() => parseAdminCommand(["delete-everything"]), /Usage:/);
});

test("운영 admission과 kill switch 명령은 배포 identity와 관리자 재인증을 요구한다", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  assert.deepEqual(
    parseAdminCommand([
      "record-canary", "--as", "admin", "--result", "passed",
      "--deployment-id", "release-42", "--config-digest", digest, "--password-stdin",
    ]),
    {
      kind: "record-canary",
      actorUsername: "admin",
      result: "PASSED",
      deploymentId: "release-42",
      configDigest: digest,
      passwordStdin: true,
    },
  );
  assert.deepEqual(
    parseAdminCommand([
      "approve-admission", "--as", "admin", "--deployment-id", "release-42",
      "--config-digest", digest,
    ]),
    {
      kind: "approve-admission",
      actorUsername: "admin",
      deploymentId: "release-42",
      configDigest: digest,
      passwordStdin: false,
    },
  );
  assert.deepEqual(
    parseAdminCommand(["enable-kill-switch", "--as", "admin"]),
    {
      kind: "set-kill-switch",
      enabled: true,
      actorUsername: "admin",
      passwordStdin: false,
    },
  );
  assert.throws(
    () => parseAdminCommand([
      "record-canary", "--as", "admin", "--result", "unknown",
      "--deployment-id", "release-42", "--config-digest", digest,
    ]),
    /--result/,
  );
});

test("migrate만 DDL을 실행하고 HMAC secret을 요구하지 않는다", () => {
  assert.deepEqual(adminCommandRuntimePolicy({ kind: "migrate" }), {
    runMigration: true,
    requiresAuthService: false,
  });
  assert.deepEqual(adminCommandRuntimePolicy({
    kind: "bootstrap",
    username: "admin",
    displayName: "Administrator",
  }), {
    runMigration: false,
    requiresAuthService: true,
  });
});
