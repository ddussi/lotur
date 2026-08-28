import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectTunnelClient } from "../../apps/client/src/index.ts";
import { createGatewayServer } from "../../apps/gateway/src/server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = join(repositoryRoot, "tests", "frameworks", "fixtures");

test("Vite 8 serves the app and applies HMR through Review Tunnel", async ({ page }) => {
  const runtime = await startRuntime("vite");
  try {
    await expectBootstrapTag(runtime.shareUrl);
    await page.goto(runtime.shareUrl);
    await expect(page.getByRole("heading", { name: "Vite through Review Tunnel" })).toBeVisible();
    await expect(page.getByTestId("hmr-marker")).toHaveText("vite-hmr-v1");
    await page.getByTestId("counter").click();
    await expect(page.getByTestId("counter")).toHaveText("count: 1");

    const sourcePath = join(runtime.fixtureDirectory, "src", "main.js");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, source.replace("vite-hmr-v1", "vite-hmr-v2"));
    await expect(page.getByTestId("hmr-marker")).toHaveText("vite-hmr-v2");
  } finally {
    await page.close();
    await runtime.close();
  }
});

test("Next.js 16 preserves RSC, Route Handler, Server Action, navigation and Fast Refresh", async ({ page }) => {
  const runtime = await startRuntime("next");
  try {
    await expectBootstrapTag(runtime.shareUrl);
    await page.goto(runtime.shareUrl);
    await expect(page.getByRole("heading", { name: "Next.js through Review Tunnel" })).toBeVisible();
    await expect(page.getByTestId("rsc-stream")).toHaveText("next-rsc-stream-ready");

    const apiMarker = await page.evaluate(async () => {
      const response = await fetch("/api/health");
      return (await response.json()).marker;
    });
    expect(apiMarker).toBe("next-route-handler-ok");

    await page.getByRole("button", { name: "run server action" }).click();
    await expect(page.getByTestId("action-result")).toHaveText("server-action-ok");
    await page.getByTestId("counter").click();
    await expect(page.getByTestId("counter")).toHaveText("count: 1");

    const sourcePath = join(runtime.fixtureDirectory, "app", "interactive-fixture.jsx");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      source.replace("next-fast-refresh-v1", "next-fast-refresh-v2"),
    );
    await expect(page.getByTestId("refresh-marker")).toHaveText("next-fast-refresh-v2");
    await expect(page.getByTestId("counter")).toHaveText("count: 1");

    await page.getByTestId("details-link").click();
    await expect(page.getByTestId("details")).toHaveText("next-client-navigation-ok");
  } finally {
    await page.close();
    await runtime.close();
  }
});

test("Next.js production HTML excludes the review bootstrap", async () => {
  const fixtureDirectory = await mkdtemp(
    join(repositoryRoot, "tests", "frameworks", ".runtime-next-production-"),
  );
  await cp(join(fixtureRoot, "next"), fixtureDirectory, { recursive: true });
  let server;
  try {
    const executable = join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
    const environment = {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      FORCE_COLOR: "0",
    };
    const build = spawn(process.execPath, [executable, "build", fixtureDirectory], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForProcess(build, "Next production build");
    const port = await reservePort();
    server = spawn(process.execPath, [
      executable,
      "start",
      fixtureDirectory,
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      output = `${output}${chunk}`.slice(-8_000);
    };
    server.stdout.on("data", capture);
    server.stderr.on("data", capture);
    server.output = () => output;
    await waitForHttp(`http://127.0.0.1:${port}/`, server);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("/_review-tunnel/review/bootstrap.js");
  } finally {
    if (server !== undefined) await stopProcess(server);
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

async function expectBootstrapTag(shareUrl) {
  const response = await fetch(shareUrl);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain('/_review-tunnel/review/bootstrap.js');
}

async function startRuntime(kind) {
  const fixtureDirectory = await mkdtemp(
    join(repositoryRoot, "tests", "frameworks", `.runtime-${kind}-`),
  );
  await cp(join(fixtureRoot, kind), fixtureDirectory, { recursive: true });
  const originPort = await reservePort();
  const gateway = createGatewayServer();
  const gatewayPort = await gateway.listen();
  const tunnelId = `${kind}-${process.pid}`;
  const framework = startFramework(kind, fixtureDirectory, originPort, {
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
    tunnelId,
  });
  let client;
  try {
    await waitForHttp(`http://127.0.0.1:${originPort}/`, framework);
    client = connectTunnelClient({
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId,
      localOrigin: `http://127.0.0.1:${originPort}`,
    });
    const shareUrl = (await client.ready).shareUrl;
    return {
      fixtureDirectory,
      shareUrl,
      async close() {
        const gracefulClose = client?.close().catch(() => undefined) ?? Promise.resolve();
        const closedGracefully = await Promise.race([
          gracefulClose.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
        if (!closedGracefully) await client.disconnect().catch(() => undefined);
        await gracefulClose;
        await stopProcess(framework);
        await gateway.close();
        await rm(fixtureDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await gateway.close().catch(() => undefined);
    await stopProcess(framework);
    await rm(fixtureDirectory, { recursive: true, force: true });
    throw error;
  }
}

function startFramework(kind, fixtureDirectory, port, integration) {
  const executable = kind === "vite"
    ? join(repositoryRoot, "node_modules", "vite", "bin", "vite.js")
    : join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
  const args = kind === "vite"
    ? [executable, fixtureDirectory, "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
    : [executable, "dev", fixtureDirectory, "--hostname", "127.0.0.1", "--port", String(port)];
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      FORCE_COLOR: "0",
      REVIEW_TUNNEL_FIXTURE_GATEWAY_URL: integration.gatewayUrl,
      REVIEW_TUNNEL_FIXTURE_TUNNEL_ID: integration.tunnelId,
      REVIEW_TUNNEL_FIXTURE_READY_FILE: integration.readyFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-8_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.output = () => output;
  return child;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`framework exited before readiness\n${child.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`framework readiness timed out: ${lastError}\n${child.output()}`);
}

async function waitForProcess(child, label) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-12_000);
  });
  child.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-12_000);
  });
  const [code, signal] = await onceProcessExit(child);
  if (code !== 0) throw new Error(`${label} failed (${code ?? signal})\n${output}`);
}

function onceProcessExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not reserve port");
  await new Promise((resolve, reject) =>
    server.close((error) => error == null ? resolve() : reject(error))
  );
  return address.port;
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
