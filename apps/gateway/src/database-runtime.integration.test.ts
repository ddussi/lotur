import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { get } from "node:http";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";

import {
  PostgresAuthRepository,
  PostgresOperationalStateRepository,
  PostgresReviewRepository,
} from "../../../packages/storage-postgres/src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("Gateway survives idle database disconnection and restores only persisted admission", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not configured" : false,
  timeout: 30_000,
}, async () => {
  assert.ok(databaseUrl !== undefined);
  const schema = `rt_runtime_${randomBytes(8).toString("hex")}`;
  const administration = new Pool({ connectionString: databaseUrl, max: 1 });
  await administration.query(`CREATE SCHEMA ${schema}`);
  const connectionUrl = new URL(databaseUrl);
  connectionUrl.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: connectionUrl.href, max: 2 });
  let stopGateway: (() => Promise<void>) | undefined;
  let unlock: (() => Promise<void>) | undefined;
  try {
    const repository = new PostgresAuthRepository(pool);
    await repository.migrate();
    await new PostgresReviewRepository(pool).migrate();
    await pool.query(`INSERT INTO rt_accounts
      (id, username, display_name, roles, password_hash, must_change_password, auth_version, created_at, updated_at)
      VALUES ('operator', 'operator', 'Operator', ARRAY['ADMIN'], 'unused', false, 1, now(), now())`);
    const identity = { deploymentId: "runtime-test", configDigest: `sha256:${"a".repeat(64)}` };
    const actor = { accountId: "operator", accountAuthVersion: 1 };
    const operations = new PostgresOperationalStateRepository(pool);
    await operations.recordCanaryResult(identity, "PASSED", actor, new Date());
    await operations.approveAdmission(identity, actor, new Date());

    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address !== null && typeof address !== "string");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const applicationName = `gateway-${schema}`;
    connectionUrl.searchParams.set("application_name", applicationName);
    const token = "runtime-test-metrics-token-".repeat(2);
    const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: connectionUrl.href,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(address.port),
        CONTENT_DOMAIN: "preview.example.test",
        CONTROL_HOST: "control.example.test",
        PUBLIC_CONTENT_ORIGIN: "https://preview.example.test",
        AUTH_SESSION_HMAC_KEY: Buffer.alloc(32, 19).toString("base64url"),
        CANARY_HOST: "canary.preview.example.test",
        CANARY_BEARER_TOKEN: "runtime-test-canary-token-".repeat(2),
        METRICS_BEARER_TOKEN: token,
        DEPLOYMENT_ID: identity.deploymentId,
        DEPLOYMENT_CONFIG_DIGEST: identity.configDigest,
        OPERATIONAL_STATE_POLL_INTERVAL_MS: "100",
        DATABASE_QUERY_TIMEOUT_MS: "500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(-8_000); });
    child.stderr.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(-8_000); });
    const exited = once(child, "exit");
    stopGateway = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const forceStop = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try { await exited; } finally { clearTimeout(forceStop); }
    };
    const readMetrics = async () => {
      assert.equal(child.exitCode, null, output);
      const response = await getGateway(address.port, "/metrics", token);
      assert.equal(response.status, 200);
      return response.body;
    };
    await eventually(async () => assert.match(await readMetrics(), /review_tunnel_gateway_admission_ready 1/));

    assert.equal((await getGateway(address.port, "/health/ready")).status, 200);

    // Prevent a refresh from hiding the outage before it can be observed.
    const lock = await pool.connect();
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE rt_operational_controls IN ACCESS EXCLUSIVE MODE");
    unlock = async () => { await lock.query("ROLLBACK"); lock.release(); };
    await eventually(async () => {
      const killed = await administration.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND state = 'idle'",
        [applicationName],
      );
      assert.ok((killed.rowCount ?? 0) > 0, "Gateway has no idle connection yet");
    });
    await eventually(async () => assert.match(await readMetrics(), /review_tunnel_gateway_admission_ready 0/));
    assert.match(output, /database_pool_connection_failed/);
    const live = await getGateway(address.port, "/health/live");
    assert.equal(live.status, 200);
    await unlock();
    unlock = undefined;
    await eventually(async () => assert.match(await readMetrics(), /review_tunnel_gateway_admission_ready 1/));

    await operations.closeAdmission(identity, actor, new Date());
    await eventually(async () => assert.match(await readMetrics(), /review_tunnel_gateway_admission_ready 0/));
    assert.equal(child.exitCode, null, output);
  } finally {
    await unlock?.();
    await stopGateway?.();
    await pool.end();
    await administration.query(`DROP SCHEMA ${schema} CASCADE`);
    await administration.end();
  }
});

async function getGateway(port: number, path: string, token?: string): Promise<{
  status: number | undefined;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = get({
      host: "127.0.0.1", port, path,
      headers: {
        host: "control.example.test",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(2_000),
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("end", () => resolve({ status: response.statusCode, body }));
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    try { await assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}
