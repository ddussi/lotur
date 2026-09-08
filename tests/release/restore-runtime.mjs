import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { cleanEnvironment, createProcesses, waitFor } from "../../scripts/demo/processes.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const purpose = "org.review-tunnel.purpose=restore-drill";
const hash = value => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const quote = name => { assert.match(name, /^[a-z_][a-z0-9_]*$/); return `"${name}"`; };

export async function snapshot(pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
  const result = { tables: {}, sequences: {} };
  for (const { tablename } of tables) {
    result.tables[tablename] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') AS data FROM public.${quote(tablename)} AS t`)).rows[0].data;
  }
  const sequences = (await pool.query("SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename")).rows;
  for (const { sequencename } of sequences) {
    result.sequences[sequencename] = (await pool.query(`SELECT last_value::text, is_called FROM public.${quote(sequencename)}`)).rows[0];
  }
  return result;
}

export async function restoreRuntime(demo) {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-restore-drill-"));
  const config = JSON.parse(await readFile(join(demo.directory, "config.json"), "utf8"));
  const environment = cleanEnvironment();
  const log = createWriteStream(join(directory, "runner.log"), { mode: 0o600 });
  const signal = new AbortController().signal;
  const passwords = { owner: secret(), runtime: secret() };
  const secrets = [config.databasePassword, config.runtimePassword, config.hmacKey, config.canaryToken,
    config.metricsToken, ...Object.values(config.passwords), ...Object.values(passwords)];
  const redact = value => secrets.reduce((text, value) => text.replaceAll(value, "[redacted]"), String(value));
  const processes = createProcesses({ root, environment, log, redact, signal });
  const docker = (label, args, options) => processes.run(label, "docker", args, options);
  const id = randomBytes(8).toString("hex");
  const network = `rt-restore-${id}`;
  const volume = `rt-restore-${id}-backup`;
  const containers = [];
  let networkOwned = false, volumeOwned = false, pool;
  const images = {};
  const evidence = { format: "review-tunnel-restore-validation-v1", images: {}, checks: {} };
  const compose = args => ["compose", "-f", join(root, "compose.demo.yml"), "--project-name", `review-tunnel-demo-${config.id}`, ...args];
  const composeEnvironment = { ...environment, DEMO_DATABASE_PASSWORD: config.databasePassword, DEMO_DATABASE_PORT: String(config.databasePort) };
  const ownerUrl = host => `postgres://restore_owner:${passwords.owner}@${host}/review_tunnel_restore`;
  const runtimeUrl = host => `postgres://restore_runtime:${passwords.runtime}@${host}/review_tunnel_restore`;
  let gatewayEnvironment;
  const nodeArgs = args => ["--import", join(root, "scripts/demo/loopback-dns.mjs"), ...args];
  const controlUrl = `http://control.localhost:${config.gatewayPort}`;

  async function initialize() {
    const revision = (await processes.run("Read source revision", "git", ["rev-parse", "HEAD"])).trim();
    const selected = process.env.RESTORE_TEST_IMAGES ? JSON.parse(process.env.RESTORE_TEST_IMAGES) : {};
    const tag = process.env.RESTORE_TEST_IMAGE_TAG ?? "restore-check";
    assert.match(tag, /^[a-zA-Z0-9_.-]+$/);
    for (const target of ["gateway", "admin-cli", "db-backup", "db-restore"]) {
      const reference = selected[target] ?? `review-tunnel-${target}:${tag}`;
      const inspected = JSON.parse(await docker(`Inspect ${target} image`, ["image", "inspect", reference]))[0];
      assert.equal(inspected.Config.Labels?.["org.opencontainers.image.revision"], revision, `${target} must be built from this exact commit`);
      images[target] = inspected.Id; // Run the inspected local identity, not a mutable tag.
      evidence.images[target] = { reference, id: inspected.Id, platform: `${inspected.Os}/${inspected.Architecture}` };
    }
    evidence.sourceRevision = revision;
    const composeText = await readFile(join(root, "compose.demo.yml"), "utf8");
    const postgresImage = composeText.match(/image:\s*(postgres:[^\s]+)/)?.[1];
    assert.match(postgresImage, /^postgres:17\.11-bookworm@sha256:[a-f0-9]{64}$/);
    evidence.postgresImage = postgresImage;
    await demo.stop();
    await docker("Restart only the quiescent source database", compose(["up", "-d", "--wait", "postgres"]), { environment: composeEnvironment });
    const source = new Pool({ connectionString: `postgres://demo_migrator:${config.databasePassword}@127.0.0.1:${config.databasePort}/review_tunnel_demo` });
    let sourceSnapshot;
    try { sourceSnapshot = await snapshot(source); }
    finally { await source.end(); }
    await docker("Create isolated restore network", ["network", "create", "--label", purpose, network]); networkOwned = true;
    await docker("Create private backup volume", ["volume", "create", "--label", purpose, volume]); volumeOwned = true;
    const uid = (await docker("Read backup image UID", ["run", "--rm", "--entrypoint", "id", images["db-backup"], "-u"])).trim();
    const gid = (await docker("Read backup image GID", ["run", "--rm", "--entrypoint", "id", images["db-backup"], "-g"])).trim();
    assert.match(uid, /^\d+$/); assert.match(gid, /^\d+$/);
    await docker("Prepare dedicated backup ownership", ["run", "--rm", "--user", "0:0", "--network", "none", "-v", `${volume}:/backup`, "--entrypoint", "node", images["db-backup"], "-e",
      `const fs=require('node:fs');fs.chownSync('/backup',${uid},${gid});fs.chmodSync('/backup',0o700);`]);
    const backupOutput = await docker("Back up source reviews", ["run", "--rm", "--network", `review-tunnel-demo-${config.id}_default`,
      "-v", `${volume}:/backup`, "-e", "DATABASE_URL", images["db-backup"], "--output-dir", "/backup"], { environment: {
      ...environment, DATABASE_URL: `postgres://demo_migrator:${config.databasePassword}@postgres:5432/review_tunnel_demo`,
    } });
    const dump = backupOutput.match(/PostgreSQL backup created: (\/backup\/[A-Za-z0-9_.-]+\.dump)/)?.[1];
    assert.ok(dump, "backup must return its exact completed file");
    const file = JSON.parse(await docker("Inspect private backup file", ["run", "--rm", "--network", "none", "-v", `${volume}:/backup:ro`,
      "--entrypoint", "node", images["db-backup"], "-e", `const fs=require('node:fs'),crypto=require('node:crypto');const p=${JSON.stringify(dump)},s=fs.lstatSync(p),d=fs.lstatSync('/backup');console.log(JSON.stringify({files:fs.readdirSync('/backup'),regular:s.isFile(),mode:s.mode&511,directoryMode:d.mode&511,uid:s.uid,bytes:s.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}));`]));
    assert.equal(file.regular, true); assert.equal(file.mode, 0o600); assert.equal(file.directoryMode, 0o700);
    assert.equal(file.uid, Number(uid)); assert.equal(file.files.length, 1); assert.ok(file.bytes > 0);
    evidence.backup = { bytes: file.bytes, sha256: file.sha256, privateMode: true };
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const container = (await docker("Create empty restore database", ["run", "-d", "--name", `rt-restore-${id}-postgres`, "--label", purpose,
      "--network", network, "--network-alias", "restore-db", "-p", `127.0.0.1:${port}:5432`,
      "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_USER=restore_owner", "-e", "POSTGRES_DB=review_tunnel_restore", "-e", "POSTGRES_PASSWORD", postgresImage], {
      environment: { ...environment, POSTGRES_PASSWORD: passwords.owner },
    })).trim(); containers.push(container);
    pool = new Pool({ connectionString: ownerUrl(`127.0.0.1:${port}`), connectionTimeoutMillis: 2000 });
    await waitFor(async () => (await pool.query("SELECT 1")).rowCount === 1, "empty restore database", { signal, timeoutMs: 60_000 });
    assert.deepEqual(await snapshot(pool), { tables: {}, sequences: {} });
    assert.equal((await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'demo_runtime'")).rowCount, 0);
    const restoreEnvironment = { ...environment, RESTORE_DATABASE_URL: ownerUrl("restore-db:5432"), CONFIRM_RESTORE_TARGET: "restore-db:5432/review_tunnel_restore" };
    const args = ["run", "--rm", "--network", network, "-v", `${volume}:/backup:ro`, "-e", "RESTORE_DATABASE_URL", "-e", "CONFIRM_RESTORE_TARGET", images["db-restore"], "--input", dump];
    const rejected = processes.start("Reject a mismatched restore confirmation", "docker", args, { environment: { ...restoreEnvironment, CONFIRM_RESTORE_TARGET: "wrong:5432/review_tunnel_restore" } });
    assert.notEqual((await rejected.finished).code, 0);
    await new Promise((resolve, reject) => log.write("", error => error ? reject(error) : resolve()));
    assert.match(await readFile(join(directory, "runner.log"), "utf8"), /set CONFIRM_RESTORE_TARGET exactly to/);
    assert.deepEqual(await snapshot(pool), { tables: {}, sequences: {} });
    evidence.checks.wrongConfirmationPreservedEmptyDatabase = true;
    const started = Date.now();
    await docker("Restore into the empty database", args, { environment: restoreEnvironment });
    evidence.restoreCommandMs = Date.now() - started;
    assert.ok(isDeepStrictEqual(await snapshot(pool), sourceSnapshot), "all table contents and sequence state must survive the dump/restore (private rows omitted)");
    evidence.checks.allTablesAndSequencesPreserved = true;
    assert.equal((await pool.query("SELECT 1 FROM pg_roles WHERE rolname IN ('demo_runtime', 'demo_migrator')")).rowCount, 0);
    await pool.query(`CREATE ROLE restore_runtime LOGIN PASSWORD '${passwords.runtime}'`);
    const limited = new Pool({ connectionString: runtimeUrl(`127.0.0.1:${port}`) });
    try {
      await assert.rejects(limited.query("SELECT id FROM rt_accounts LIMIT 1"), error => error.code === "42501");
      await pool.query(`GRANT USAGE ON SCHEMA public TO restore_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restore_runtime;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restore_runtime;
        ALTER DEFAULT PRIVILEGES FOR ROLE restore_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO restore_runtime;
        ALTER DEFAULT PRIVILEGES FOR ROLE restore_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO restore_runtime;`);
      assert.ok((await limited.query("SELECT id FROM rt_accounts")).rowCount >= 3);
      await assert.rejects(limited.query("CREATE TABLE should_not_be_allowed(id integer)"), error => error.code === "42501");
      const role = (await limited.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
      assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    } finally { await limited.end(); }
    evidence.checks.runtimeRoleRecreatedWithoutDdl = true;
    for (let attempt = 0; attempt < 2; attempt += 1) await docker("Repeat candidate migration on restored data", ["run", "--rm", "--network", network,
      "-e", "DATABASE_URL", images["admin-cli"], "migrate"], { environment: { ...environment, DATABASE_URL: ownerUrl("restore-db:5432") } });
    assert.ok(isDeepStrictEqual(await snapshot(pool), sourceSnapshot), "repeated migrations must preserve the restored records, times and sequence state (private rows omitted)");
    evidence.checks.repeatedMigrationsPreservedData = true;
    evidence.preservedTables = Object.fromEntries(Object.entries(sourceSnapshot.tables).map(([name, rows]) => [name, rows.length]));
    evidence.preservedSequenceCount = Object.keys(sourceSnapshot.sequences).length;
    evidence.serverVersion = (await pool.query("SHOW server_version")).rows[0].server_version;
    evidence.tools = {};
    for (const [target, command] of [["db-backup", "pg_dump"], ["db-restore", "pg_restore"]]) {
      evidence.tools[command] = (await docker("Read restored tool version", ["run", "--rm", "--entrypoint", command, images[target], "--version"])).trim();
    }
    gatewayEnvironment = { ...environment, GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: String(config.gatewayPort),
      CONTROL_HOST: `control.localhost:${config.gatewayPort}`, CONTENT_DOMAIN: "preview.localhost", PUBLIC_CONTENT_ORIGIN: `http://preview.localhost:${config.gatewayPort}`,
      ALLOW_INSECURE_HTTP_AUTH: "true", AUTO_MIGRATE: "false", DATABASE_URL: runtimeUrl(`127.0.0.1:${port}`),
      AUTH_SESSION_HMAC_KEY: config.hmacKey, CANARY_HOST: "canary.preview.localhost", CANARY_BEARER_TOKEN: config.canaryToken,
      METRICS_BEARER_TOKEN: config.metricsToken, REVIEW_WORKFLOW_ENABLED: "true", DEPLOYMENT_ID: `restore-${randomUUID()}` };
    gatewayEnvironment.DEPLOYMENT_CONFIG_DIGEST = `sha256:${hash(JSON.stringify(gatewayEnvironment))}`;
    let gateway;
    if (process.platform === "linux") {
      const args = ["run", "-d", "--read-only", "--tmpfs", "/tmp", "--network", "host", "--label", purpose];
      for (const key of Object.keys(gatewayEnvironment).filter(key => !(key in environment))) args.push("-e", key);
      containers.push((await docker("Start candidate Gateway image", [...args, images.gateway], { environment: gatewayEnvironment })).trim());
      evidence.gatewayMode = "candidate-image";
    } else {
      gateway = processes.start("Start restored Gateway", process.execPath, nodeArgs(["apps/gateway/src/main.ts"]), { environment: gatewayEnvironment });
      evidence.gatewayMode = "host-source";
    }
    await import("../../scripts/demo/loopback-dns.mjs");
    const options = { signal, processes: gateway ? [gateway] : [] };
    await waitFor(async () => (await fetch(`${controlUrl}/health/ready`, { signal: AbortSignal.timeout(2000) })).ok, "restored Gateway", options);
    const metrics = async () => await (await fetch(`${controlUrl}/metrics`, { headers: { authorization: `Bearer ${config.metricsToken}` } })).text();
    assert.match(await metrics(), /review_tunnel_gateway_admission_ready 0\b/);
    evidence.checks.oldAdmissionDidNotApproveNewDeployment = true;
    await processes.run("Check restored local path", process.execPath, nodeArgs(["scripts/verify-public-path.mjs"]), { environment: {
      ...gatewayEnvironment, CANARY_CONTENT_URL: `http://canary.preview.localhost:${config.gatewayPort}`, ALLOW_INSECURE_CANARY: "true",
    } });
    const identity = ["--deployment-id", gatewayEnvironment.DEPLOYMENT_ID, "--config-digest", gatewayEnvironment.DEPLOYMENT_CONFIG_DIGEST];
    for (const command of [["record-canary", "--result", "passed", ...identity], ["approve-admission", ...identity]]) {
      await docker("Approve restored candidate identity", ["run", "--rm", "-i", "--network", network, "-e", "DATABASE_URL", "-e", "AUTH_SESSION_HMAC_KEY",
        images["admin-cli"], ...command, "--as", "admin", "--password-stdin"], { environment: {
        ...environment, DATABASE_URL: runtimeUrl("restore-db:5432"), AUTH_SESSION_HMAC_KEY: config.hmacKey,
      }, input: `${config.passwords.admin}\n` });
    }
    await waitFor(async () => /review_tunnel_gateway_admission_ready 1\b/.test(await metrics()), "restored candidate admission", options);
    evidence.checks.freshCanaryAndAdmissionPassed = true;
    return { controlUrl, config, pool, evidence };
  }

  async function startShare() {
    const app = processes.start("Restored Vite example", process.execPath, ["node_modules/vite/bin/vite.js", "examples/vite-review", "--host", "127.0.0.1", "--port", String(config.appPort), "--strictPort"], { environment });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${config.appPort}`)).ok, "restored example", { signal, processes: [app] });
    const client = processes.start("Share with a restored developer account", process.execPath, nodeArgs(["apps/client/src/main.ts", `http://127.0.0.1:${config.appPort}`,
      "--gateway", `ws://control.localhost:${config.gatewayPort}/_review-tunnel/carrier`, "--username", "developer", "--password-stdin", "--review-project", "launch-checklist", "--review-revision", "demo-v1"]), {
      environment: gatewayEnvironment, input: `${config.passwords.developer}\n`,
    });
    return waitFor(() => client.output().match(/Tunnel ready: (\S+)/)?.[1], "new restored share", { signal, processes: [app, client] });
  }

  async function close() {
    const cleanup = createProcesses({ root, environment, log, redact, signal });
    const failures = [];
    const attempt = async action => { try { await action(); } catch (error) { failures.push(error); } };
    try {
      await attempt(() => processes.stopAll());
      await attempt(() => pool?.end());
      for (const container of containers.reverse()) {
        await attempt(async () => {
          assert.match(container, /^[a-f0-9]{64}$/);
          await cleanup.run("Delete owned restore container", "docker", ["rm", "-f", container]);
        });
      }
      if (volumeOwned) await attempt(() => cleanup.run("Delete owned synthetic dump", "docker", ["volume", "rm", volume]));
      if (networkOwned) await attempt(() => cleanup.run("Delete owned restore network", "docker", ["network", "rm", network]));
    } finally {
      await cleanup.stopAll();
      log.end(); await once(log, "close");
      await rm(directory, { recursive: true, force: true });
    }
    if (failures.length) throw new AggregateError(failures, "Some restore drill resources could not be cleaned up");
  }
  return { initialize, startShare, close, evidence, diagnostics: async () => redact(await readFile(join(directory, "runner.log"), "utf8")) };
}
