import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAdminCommand } from "./arguments.ts";

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
