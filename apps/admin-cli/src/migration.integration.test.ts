import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

import {
  PostgresAuthRepository,
  PostgresReviewRepository,
} from "../../../packages/storage-postgres/src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = promisify(execFile);

for (const initialSchema of ["empty", "auth-only"]) {
  test(`Admin CLI migrate initializes reviews from ${initialSchema} and is repeatable`, {
    skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
    timeout: 30_000,
  }, async () => {
    assert.ok(databaseUrl !== undefined);
    const schema = `rt_cli_migration_${randomBytes(8).toString("hex")}`;
    const administration = new Pool({ connectionString: databaseUrl, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    const connectionUrl = new URL(databaseUrl);
    connectionUrl.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: connectionUrl.href, max: 1 });
    try {
      if (initialSchema === "auth-only") {
        await new PostgresAuthRepository(pool).migrate();
        await pool.query(`INSERT INTO rt_accounts
          (id, username, display_name, roles, password_hash, must_change_password,
           auth_version, created_at, updated_at)
          VALUES ('existing', 'existing', 'Existing', ARRAY['ADMIN'], 'unused',
                  false, 1, now(), now())`);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await run(process.execPath, [
          fileURLToPath(new URL("./main.ts", import.meta.url)), "migrate",
        ], {
          env: { NODE_ENV: "test", DATABASE_URL: connectionUrl.href },
          timeout: 10_000,
        });
        assert.match(result.stdout, /Database migration complete/);
        await new PostgresReviewRepository(pool).checkHealth();
        const tables = await pool.query<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname = $1", [schema],
        );
        const names = new Set(tables.rows.map((row) => row.name));
        for (const name of [
          "rt_accounts", "rt_review_projects", "rt_review_revisions",
          "rt_review_tunnel_bindings", "rt_review_threads", "rt_review_replies",
          "rt_review_events", "rt_review_notifications",
        ]) assert.ok(names.has(name), `migration omitted ${name}`);
      }
      const accounts = await pool.query<{ id: string }>("SELECT id FROM rt_accounts");
      assert.deepEqual(accounts.rows, initialSchema === "auth-only" ? [{ id: "existing" }] : []);
    } finally {
      await pool.end();
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    }
  });
}
