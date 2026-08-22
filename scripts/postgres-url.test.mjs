import assert from "node:assert/strict";
import test from "node:test";

import { parsePostgresTarget, postgresEnvironment } from "./postgres-url.mjs";

test("PostgreSQL URL은 pg client 환경으로 분해되고 허용하지 않은 옵션은 거부된다", () => {
  const { target, databaseName } = parsePostgresTarget(
    "postgres://user:p%40ss@db.internal:5544/review_tunnel?sslmode=require",
    "DATABASE_URL",
  );
  assert.equal(databaseName, "review_tunnel");
  assert.deepEqual(postgresEnvironment(target, {}), {
    PGHOST: "db.internal",
    PGPORT: "5544",
    PGDATABASE: "review_tunnel",
    PGUSER: "user",
    PGPASSWORD: "p@ss",
    PGSSLMODE: "require",
  });
  assert.throws(
    () => postgresEnvironment(new URL("postgres://u:p@db/name?options=unsafe"), {}),
    /unsupported PostgreSQL URL parameter/,
  );
});

test("PostgreSQL URL은 protocol과 database 이름을 fail-closed 검증한다", () => {
  assert.throws(() => parsePostgresTarget("http://db/name", "DATABASE_URL"), /postgres/);
  assert.throws(() => parsePostgresTarget("postgres://db", "DATABASE_URL"), /database name/);
});
