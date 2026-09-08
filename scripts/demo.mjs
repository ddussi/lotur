import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  parseArguments, prepareDirectory, acquireLock, loadConfig, loadOrCreateConfig,
  writePrivate, credentials, stateFiles,
} from "./demo/state.mjs";
import { cleanEnvironment, createProcesses, requireFreePort, waitFor } from "./demo/processes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const help = `Review Tunnel local demo (Node.js 24+, local Docker Engine 28+, Docker Compose)

  npm run demo
  npm run demo -- credentials
  npm run demo -- reset --confirm-delete-demo-data

Options:
  --state-dir <directory>   Separate demo data/config directory (default: .review-tunnel-demo)
  --gateway-port <port>     Initial Gateway port (default: 8788)
  --app-port <port>         Initial Vite app port (default: 5178)
  --database-port <port>    Initial PostgreSQL port (default: 54339)

Start keeps running until Ctrl+C. Stopping preserves saved reviews.
Credentials are stored in a private accounts.json file; credentials prints them explicitly.
Reset deletes only this demo's database volume and generated files, and requires the flag above.
The demo listens only on this computer. It is not a hosted sharing service.
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) console.log(help);
else {
  try { await main(parseArguments(process.argv.slice(2), root)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

async function main(options) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Use Node.js 24 or newer for the local demo.");
  if (options.command !== "start") {
    const config = await loadConfig(options.directory);
    if (!config) throw new Error("No initialized demo exists in that directory. Start it with npm run demo.");
    if (options.command === "credentials") {
      console.log(JSON.stringify(credentials(config), null, 2));
      return;
    }
    if (!options.confirmReset) throw new Error("Reset deletes saved demo feedback. Add --confirm-delete-demo-data to proceed.");
  }
  await prepareDirectory(options.directory);
  const releaseLock = await acquireLock(options.directory);
  const abort = new AbortController();
  let userStopped = false;
  const stopRequested = () => { userStopped = true; abort.abort(new Error("Demo stopped.")); };
  process.once("SIGINT", stopRequested);
  process.once("SIGTERM", stopRequested);
  let config;
  let log;
  let processes;
  let databaseStarted = false;
  let resetComplete = false;
  const environment = cleanEnvironment();
  const redacted = value => {
    let text = String(value);
    for (const secret of config ? [config.databasePassword, config.runtimePassword, config.hmacKey,
      config.metricsToken, config.canaryToken, ...Object.values(config.passwords),
      ...Object.values(config.pendingPasswords ?? {})] : []) text = text.replaceAll(secret, "[redacted]");
    return text;
  };
  const nodeArgs = arguments_ => ["--import", join(root, "scripts/demo/loopback-dns.mjs"), ...arguments_];
  const composeArgs = arguments_ => ["compose", "-f", join(root, "compose.demo.yml"),
    "--project-name", `review-tunnel-demo-${config.id}`, ...arguments_];
  const dockerEnvironment = () => ({ ...environment,
    DEMO_DATABASE_PASSWORD: config.databasePassword, DEMO_DATABASE_PORT: String(config.databasePort),
  });
  try {
    config = options.command === "start"
      ? await loadOrCreateConfig(options.directory, options.ports) : await loadConfig(options.directory);
    log = createWriteStream(join(options.directory, "runner.log"), { flags: "a", mode: 0o600 });
    let logError;
    log.on("error", error => { logError = error; abort.abort(error); });
    processes = createProcesses({ root, environment, log, redact: redacted, signal: abort.signal });
    const endpoint = environment.DOCKER_HOST && !environment.DOCKER_CONTEXT ? environment.DOCKER_HOST : (await processes.run("Docker context", "docker", [
      "context", "inspect", ...(environment.DOCKER_CONTEXT ? [environment.DOCKER_CONTEXT] : []),
      "--format", "{{.Endpoints.docker.Host}}",
    ])).trim();
    if (!/^(unix|npipe):\/\//.test(endpoint)) throw new Error("The demo requires a local Docker socket, not a remote Docker host.");
    const dockerVersion = await processes.run("Docker Engine", "docker", ["info", "--format", "{{.ServerVersion}}"]);
    if (Number(dockerVersion.trim().split(".")[0]) < 28) throw new Error("Use Docker Engine 28 or newer for loopback-only port publishing.");
    await processes.run("Docker Compose", "docker", ["compose", "version", "--short"]);
    if (options.command === "reset") {
      await processes.run("Delete demo database", "docker", composeArgs(["down", "--volumes"]), { environment: dockerEnvironment() });
      resetComplete = true;
      console.log("Demo database and generated credentials deleted. Your app source was preserved.");
      return;
    }
    await requireFreePort(config.gatewayPort, "Gateway");
    await requireFreePort(config.appPort, "App");
    await unlink(join(options.directory, "ready.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
    console.log("Starting local demo database…");
    databaseStarted = true;
    await processes.run("Demo database", "docker", composeArgs(["up", "-d", "--wait", "--wait-timeout", "60"]), {
      environment: dockerEnvironment(), timeoutMs: 240_000,
    });
    await import("./demo/loopback-dns.mjs");
    const { initializeDemo, databaseUrl } = await import("./demo/bootstrap.mjs");
    const gatewayEnvironment = {
      ...environment, GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: String(config.gatewayPort),
      CONTROL_HOST: `control.localhost:${config.gatewayPort}`, CONTENT_DOMAIN: "preview.localhost",
      PUBLIC_CONTENT_ORIGIN: `http://preview.localhost:${config.gatewayPort}`,
      ALLOW_INSECURE_HTTP_AUTH: "true", AUTO_MIGRATE: "false", DATABASE_URL: databaseUrl(config),
      AUTH_SESSION_HMAC_KEY: config.hmacKey, CANARY_HOST: "canary.preview.localhost",
      CANARY_BEARER_TOKEN: config.canaryToken, METRICS_BEARER_TOKEN: config.metricsToken,
      REVIEW_WORKFLOW_ENABLED: "true", DEPLOYMENT_ID: `demo-${config.id}-${randomUUID()}`,
    };
    gatewayEnvironment.DEPLOYMENT_CONFIG_DIGEST = `sha256:${createHash("sha256")
      .update(JSON.stringify(gatewayEnvironment)).digest("hex")}`;
    const runNode = (label, arguments_, extra = {}) => processes.run(label, process.execPath, nodeArgs(arguments_), {
      environment: gatewayEnvironment, ...extra,
    });
    console.log("Preparing schema and local reviewer/developer accounts…");
    await initializeDemo({ config, signal: abort.signal, log,
      save: () => writePrivate(join(options.directory, "config.json"), config),
      runMigrations: () => runNode("Migrate demo database", ["apps/admin-cli/src/main.ts", "migrate"], {
        environment: { ...gatewayEnvironment, DATABASE_URL: databaseUrl(config, true) },
      }),
    });
    await writePrivate(join(options.directory, "accounts.json"), credentials(config));
    // Build the existing integration once; the example imports its generated package.
    await processes.run("Build Vite integration", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "apps/vite-integration/tsconfig.build.json"]);
    const gateway = processes.start("Gateway", process.execPath, nodeArgs(["apps/gateway/src/main.ts"]), { environment: gatewayEnvironment });
    const controlUrl = `http://control.localhost:${config.gatewayPort}`;
    const waitOptions = { signal: abort.signal, processes: [gateway] };
    const response = path => fetch(`${controlUrl}${path}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) });
    await waitFor(async () => (await response("/health/ready")).ok, "Gateway database readiness", waitOptions);
    console.log("Verifying authentication, streaming and sharing admission…");
    await runNode("Local canary", ["scripts/verify-public-path.mjs"], { environment: {
      ...gatewayEnvironment, CANARY_CONTENT_URL: `http://canary.preview.localhost:${config.gatewayPort}`,
      ALLOW_INSECURE_CANARY: "true",
    } });
    const identity = ["--deployment-id", gatewayEnvironment.DEPLOYMENT_ID, "--config-digest", gatewayEnvironment.DEPLOYMENT_CONFIG_DIGEST];
    for (const arguments_ of [
      ["record-canary", "--result", "passed", ...identity], ["approve-admission", ...identity],
      ["disable-kill-switch"],
    ]) await runNode("Approve local sharing", ["apps/admin-cli/src/main.ts", ...arguments_, "--as", "admin", "--password-stdin"], {
      input: `${config.passwords.admin}\n`,
    });
    await waitFor(async () => {
      const metrics = await fetch(`${controlUrl}/metrics`, { headers: { authorization: `Bearer ${config.metricsToken}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) });
      return metrics.ok && /review_tunnel_gateway_admission_ready 1\b/.test(await metrics.text());
    }, "Gateway admission approval", waitOptions);
    const app = processes.start("Vite example", process.execPath, ["node_modules/vite/bin/vite.js", "examples/vite-review",
      "--host", "127.0.0.1", "--port", String(config.appPort), "--strictPort"], { environment });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${config.appPort}`, { signal: AbortSignal.timeout(2000) })).ok,
      "Vite example", { ...waitOptions, processes: [gateway, app] });
    const client = processes.start("Client", process.execPath, nodeArgs([
      "apps/client/src/main.ts", `http://127.0.0.1:${config.appPort}`, "--gateway", `ws://control.localhost:${config.gatewayPort}/_review-tunnel/carrier`,
      "--username", "developer", "--password-stdin", "--review-project", "launch-checklist", "--review-revision", "demo-v1",
    ]), { environment: gatewayEnvironment, input: `${config.passwords.developer}\n` });
    const shareUrl = await waitFor(() => client.output().match(/Tunnel ready: (\S+)/)?.[1], "shared example URL", {
      signal: abort.signal, processes: [gateway, app, client],
    });
    const ready = { shareUrl, controlUrl, inboxUrl: `${controlUrl}/reviews`, project: "launch-checklist", revision: "demo-v1" };
    await writePrivate(join(options.directory, "ready.json"), ready);
    console.log(`\nDemo ready\nShared app: ${shareUrl}\nReview inbox: ${ready.inboxUrl}\nLocal credentials: ${join(options.directory, "accounts.json")}\n\nUse reviewer and developer in separate browser profiles.\nPress Ctrl+C to stop. Saved feedback will remain for your next run.`);
    abort.signal.throwIfAborted();
    const ended = await Promise.race([
      ...[gateway, app, client].map(item => item.finished.then(() => item.label)),
      new Promise(resolve => abort.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
    ]);
    if (ended && !abort.signal.aborted) throw new Error(`${ended} stopped unexpectedly. See the private runner log.`);
    if (logError) throw logError;
  } catch (error) {
    if (!userStopped) throw new Error(redacted(error.message));
  } finally {
    await processes?.stopAll();
    if (databaseStarted) {
      const cleanup = createProcesses({ root, environment, log, redact: redacted, signal: new AbortController().signal });
      try { await cleanup.run("Stop demo database", "docker", composeArgs(["stop", "postgres"]), { environment: dockerEnvironment(), timeoutMs: 30_000 }); }
      catch { console.error("Demo processes stopped, but Docker could not stop the demo database. Its data was preserved; see runner.log."); process.exitCode = 1; }
      finally { await cleanup.stopAll(); }
    }
    if (log && !log.closed) { log.end(); await once(log, "close").catch(() => {}); }
    if (resetComplete) {
      for (const file of stateFiles) await unlink(join(options.directory, file)).catch(error => { if (error.code !== "ENOENT") throw error; });
    } else if (options.command === "start") {
      await unlink(join(options.directory, "ready.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    await releaseLock();
    process.off("SIGINT", stopRequested);
    process.off("SIGTERM", stopRequested);
  }
}
