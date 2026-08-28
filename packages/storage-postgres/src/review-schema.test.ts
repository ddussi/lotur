import assert from "node:assert/strict";
import { test } from "node:test";

import { REVIEW_SCHEMA_SQL } from "./review-schema.ts";

test("review schema separates stable projects and revisions from temporary tunnel bindings", () => {
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_projects/);
  assert.match(REVIEW_SCHEMA_SQL, /UNIQUE \(owner_account_id, slug\)/);
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_revisions/);
  assert.match(REVIEW_SCHEMA_SQL, /UNIQUE \(project_id, revision_key\)/);
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_tunnel_bindings/);
  assert.match(REVIEW_SCHEMA_SQL, /session_id text NOT NULL UNIQUE/);
  assert.match(REVIEW_SCHEMA_SQL, /REFERENCES rt_review_revisions\(id\) ON DELETE CASCADE/);
});

test("review comments are bounded page anchors with revision and account ownership", () => {
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_threads/);
  assert.match(REVIEW_SCHEMA_SQL, /anchor_type IN \('PAGE', 'REGION'\)/);
  assert.match(REVIEW_SCHEMA_SQL, /anchor_type = 'PAGE' AND anchor IS NULL/);
  assert.match(REVIEW_SCHEMA_SQL, /anchor->>'type' = 'REGION_V1'/);
  assert.match(REVIEW_SCHEMA_SQL, /char_length\(route_path\) BETWEEN 1 AND 2048/);
  assert.match(REVIEW_SCHEMA_SQL, /position\('\?' IN route_path\) = 0/);
  assert.match(REVIEW_SCHEMA_SQL, /char_length\(body\) BETWEEN 1 AND 4000/);
  assert.match(REVIEW_SCHEMA_SQL, /REFERENCES rt_accounts\(id\) ON DELETE RESTRICT/);
  assert.match(REVIEW_SCHEMA_SQL, /resolved_by_account_id/);
  assert.match(REVIEW_SCHEMA_SQL, /resolved_at/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_review_threads_resolution_shape/);
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_replies/);
  assert.match(REVIEW_SCHEMA_SQL, /thread_id text NOT NULL REFERENCES rt_review_threads\(id\) ON DELETE CASCADE/);
  assert.match(REVIEW_SCHEMA_SQL, /content_version integer NOT NULL DEFAULT 1/);
  assert.match(REVIEW_SCHEMA_SQL, /deleted_by_account_id/);
  assert.match(REVIEW_SCHEMA_SQL, /deleted_at timestamptz/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_review_threads_body_shape/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_review_replies_body_shape/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_schema_migrations\(version\) VALUES \(10\)/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_schema_migrations\(version\) VALUES \(11\)/);
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_events/);
  assert.match(REVIEW_SCHEMA_SQL, /event_type text NOT NULL/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_review_events_revision_route_id_idx/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_schema_migrations\(version\) VALUES \(12\)/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_schema_migrations\(version\) VALUES \(13\)/);
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_mentions/);
  assert.match(REVIEW_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS rt_review_notifications/);
  assert.match(REVIEW_SCHEMA_SQL, /recipient_account_id text NOT NULL/);
  assert.match(REVIEW_SCHEMA_SQL, /ADD COLUMN IF NOT EXISTS recipient_account_id/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_schema_migrations\(version\) VALUES \(14\)/);
  assert.match(REVIEW_SCHEMA_SQL, /NOTIFICATION_READ_CHANGED/);
  assert.match(REVIEW_SCHEMA_SQL, /rt_schema_migrations\(version\) VALUES \(17\)/);
});
