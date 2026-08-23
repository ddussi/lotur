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

test("운영 kill switch와 배포별 admission은 PostgreSQL schema에 영속된다", () => {
  assert.match(AUTH_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_operational_controls/);
  assert.match(AUTH_SCHEMA_SQL, /kill_switch_enabled boolean NOT NULL/);
  assert.match(AUTH_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_deployment_admissions/);
  assert.match(AUTH_SCHEMA_SQL, /PRIMARY KEY \(deployment_id, config_digest\)/);
  assert.match(AUTH_SCHEMA_SQL, /canary_status text NOT NULL/);
  assert.match(AUTH_SCHEMA_SQL, /admission_approved_at timestamptz/);
});

test("login throttle과 audit hard cap 카운터는 기존 행으로 원자적으로 재구성된다", () => {
  assert.match(AUTH_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_login_throttle_capacity/);
  assert.match(AUTH_SCHEMA_SQL, /SELECT count\(\*\) FROM rt_login_throttles/);
  assert.match(AUTH_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_audit_event_capacity/);
  assert.match(AUTH_SCHEMA_SQL, /SELECT count\(\*\) FROM rt_audit_events/);
  assert.match(AUTH_SCHEMA_SQL, /rt_schema_migrations\(version\) VALUES \(8\)/);
});
