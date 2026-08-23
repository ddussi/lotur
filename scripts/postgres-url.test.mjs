import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePostgresTarget,
  postgresEnvironment,
  postgresTargetConfirmation,
} from "./postgres-url.mjs";

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
    PGCONNECT_TIMEOUT: "10",
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
  assert.throws(() => parsePostgresTarget("postgres:///name", "DATABASE_URL"), /host/);
  assert.throws(
    () => parsePostgresTarget("postgres://user:secret@primary,secondary/name", "DATABASE_URL"),
    /single PostgreSQL host/,
  );
});

test("IPv6 PostgreSQL target은 libpq와 confirmation에 맞게 정규화한다", () => {
  const parsed = parsePostgresTarget(
    "postgres://user:secret@[2001:db8::10]:5544/review",
    "DATABASE_URL",
  );

  assert.equal(postgresEnvironment(parsed.target, {}).PGHOST, "2001:db8::10");
  assert.equal(postgresTargetConfirmation(parsed), "[2001:db8::10]:5544/review");
});

test("PostgreSQL child 환경은 URL 밖의 libpq override를 모두 제거한다", () => {
  const environment = postgresEnvironment(
    new URL("postgres://user:secret@safe-db.internal/review?sslmode=require"),
    {
      PATH: "/usr/local/bin:/usr/bin",
      LANG: "ko_KR.UTF-8",
      PGHOSTADDR: "203.0.113.99",
      PGSSLMODE: "disable",
      PGOPTIONS: "-c search_path=attacker",
      PGSERVICE: "unsafe",
      PGSERVICEFILE: "/tmp/unsafe.conf",
      PGAPPNAME: "inherited",
      LD_PRELOAD: "/tmp/unsafe.so",
      NODE_OPTIONS: "--require=/tmp/unsafe.cjs",
      AWS_SECRET_ACCESS_KEY: "must-not-leak-to-pg-tools",
    },
  );

  assert.deepEqual(environment, {
    PATH: "/usr/local/bin:/usr/bin",
    LANG: "ko_KR.UTF-8",
    PGHOST: "safe-db.internal",
    PGPORT: "5432",
    PGDATABASE: "review",
    PGUSER: "user",
    PGPASSWORD: "secret",
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "10",
  });
});

test("PostgreSQL 연결은 기본 deadline을 갖고 중복·무제한 timeout을 거부한다", () => {
  assert.equal(
    postgresEnvironment(new URL("postgres://u:p@db.internal/review"), {}).PGCONNECT_TIMEOUT,
    "10",
  );
  assert.throws(
    () => postgresEnvironment(
      new URL("postgres://u:p@db.internal/review?sslmode=require&sslmode=disable"),
      {},
    ),
    /duplicate PostgreSQL URL parameter: sslmode/,
  );
  for (const timeout of ["0", "61", "not-a-number"]) {
    assert.throws(
      () => postgresEnvironment(
        new URL(`postgres://u:p@db.internal/review?connect_timeout=${timeout}`),
        {},
      ),
      /connect_timeout must be an integer between 1 and 60 seconds/,
    );
  }
});
