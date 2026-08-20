import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTH_SCHEMA_SQL } from "./schema.ts";

test("auth schema makes usernames and session token digests unique", () => {
  assert.match(AUTH_SCHEMA_SQL, /username text NOT NULL UNIQUE/);
  assert.match(AUTH_SCHEMA_SQL, /token_digest text NOT NULL UNIQUE/);
});

test("auth schema cascades account deletion to sessions and restricts roles", () => {
  assert.match(AUTH_SCHEMA_SQL, /REFERENCES rt_accounts\(id\) ON DELETE CASCADE/);
  assert.match(AUTH_SCHEMA_SQL, /roles <@ ARRAY\['ADMIN', 'DEVELOPER', 'REVIEWER'\]/);
});
