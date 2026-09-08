import { expect, test } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AuthService, InMemoryAuthRepository, Argon2idPasswordHasher } from "../../packages/auth/src/index.ts";
import { createCarrierAuthentication } from "../../apps/client/src/control-client.ts";

import { connectTunnelClient } from "../../apps/client/src/client.ts";
import { createGatewayServer } from "../../apps/gateway/src/server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = join(repositoryRoot, "tests", "frameworks", "fixtures");
const execute = promisify(execFile);

test("Vite 8 supports login, HMR and revocation through an authenticated Gateway", async ({ page }) => {
  const runtime = await startRuntime("vite");
  try {
    await loginReviewer(page, runtime);
    await expect(page.locator('script[src="/_review-tunnel/review/bootstrap.js"]')).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Vite through Review Tunnel" })).toBeVisible();
    await expect(page.getByTestId("hmr-marker")).toHaveText("vite-hmr-v1");
    await page.getByTestId("counter").click();
    await expect(page.getByTestId("counter")).toHaveText("count: 1");

    const sourcePath = join(runtime.fixtureDirectory, "src", "main.js");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, source.replace("vite-hmr-v1", "vite-hmr-v2"));
    await expect(page.getByTestId("hmr-marker")).toHaveText("vite-hmr-v2");
    await verifyReviewerRevocation(page, runtime);
  } finally {
    await page.close();
    await runtime.close();
  }
});

test("Next.js 16 supports authenticated RSC, Server Actions, navigation, Fast Refresh and revocation", async ({ page }) => {
  const runtime = await startRuntime("next");
  try {
    await loginReviewer(page, runtime);
    await expect(page.locator('script[src="/_review-tunnel/review/bootstrap.js"]')).toHaveCount(1);
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
    await verifyReviewerRevocation(page, runtime);
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
    await installPackedIntegration(fixtureDirectory, "next");
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

async function startRuntime(kind) {
  const accounts = await prepareAccounts(kind === "next");
  const gatewayPort = await reservePort();
  const originPort = await reservePort();
  const controlUrl = `http://control.localhost:${gatewayPort}`;
  const gateway = createGatewayServer({
    port: gatewayPort,
    contentDomain: "preview.localhost",
    controlHost: `control.localhost:${gatewayPort}`,
    secureCookies: false,
    authService: accounts.service,
    authorizationCheckIntervalMs: 100,
  });
  const fixtureDirectory = await mkdtemp(
    join(repositoryRoot, "tests", "frameworks", `.runtime-${kind}-`),
  );
  let framework;
  let client;
  let authentication;
  try {
    await cp(join(fixtureRoot, kind), fixtureDirectory, { recursive: true });
    await installPackedIntegration(fixtureDirectory, kind);
    framework = startFramework(kind, fixtureDirectory, originPort);
    await waitForHttp(`http://127.0.0.1:${originPort}/`, framework);
    await gateway.listen();
    authentication = await createCarrierAuthentication({
      controlUrl,
      username: "developer",
      password: accounts.password,
    });
    client = connectTunnelClient({
      gatewayUrl: `ws://control.localhost:${gatewayPort}/_review-tunnel/carrier`,
      tunnelId: authentication.tunnelId,
      carrierCredential: authentication.carrierCredential,
      localOrigin: `http://127.0.0.1:${originPort}`,
    });
    const active = await client.ready;
    return {
      fixtureDirectory,
      shareUrl: active.shareUrl,
      controlUrl,
      reviewerPassword: accounts.reviewerPassword,
      passwordAfterChange: accounts.password,
      reviewerNeedsPasswordChange: kind === "next",
      async revokeReviewer() {
        await accounts.service.revokeSessions(accounts.administrator, accounts.reviewer.accountId);
      },
      async close() {
        const gracefulClose = client.close().catch(() => undefined);
        const closedGracefully = await Promise.race([
          gracefulClose.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
        if (!closedGracefully) await client.disconnect().catch(() => undefined);
        await gracefulClose;
        await authentication.close();
        await gateway.close();
        await stopProcess(framework);
        await rm(fixtureDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await authentication?.close().catch(() => undefined);
    await gateway.close().catch(() => undefined);
    if (framework !== undefined) await stopProcess(framework);
    await rm(fixtureDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function installPackedIntegration(directory, kind) {
  const packagePath = join(repositoryRoot, "apps", kind === "vite" ? "vite-integration" : "next-integration");
  const environment = { ...process.env, npm_config_cache: join(directory, ".npm-cache"), npm_config_audit: "false", npm_config_fund: "false" };
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: `review-tunnel-${kind}-consumer`, private: true, type: "module" }));
  const { stdout } = await execute("npm", ["pack", packagePath, "--json", "--pack-destination", directory], { cwd: repositoryRoot, env: environment });
  const [packed] = JSON.parse(stdout);
  await execute("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", join(directory, packed.filename)], { cwd: directory, env: environment });
  const { stdout: installed } = await execute(process.execPath, ["--input-type=module", "--eval", `console.log(import.meta.resolve('@review-tunnel/${kind}'))`], { cwd: directory, env: environment });
  expect(fileURLToPath(installed.trim())).toBe(join(directory, "node_modules", "@review-tunnel", kind, "dist", "index.js"));
}

async function prepareAccounts(reviewerNeedsPasswordChange) {
  const hasher = new Argon2idPasswordHasher();
  const service = new AuthService({
    repository: new InMemoryAuthRepository(),
    passwordHasher: hasher,
    sessionHmacKey: randomBytes(32),
    dummyPasswordHash: await hasher.hash("framework-test-dummy-password"),
    authenticationEventSink: { write() {}, reportFailure() {} },
  });
  const password = "framework-test-password-2026";
  async function activateAccount(created) {
    const temporary = await service.authenticate({
      username: created.account.username, password: created.temporaryPassword, remoteAddress: "127.0.0.1",
    });
    await service.changeOwnPassword(temporary.principal, {
      currentPassword: created.temporaryPassword, newPassword: password,
    });
    return (await service.authenticate({
      username: created.account.username, password, remoteAddress: "127.0.0.1",
    })).principal;
  }
  const administrator = await activateAccount(await service.bootstrapAdministrator({
    username: "administrator", displayName: "Administrator",
  }));
  await activateAccount(await service.createAccount(administrator, {
    username: "developer", displayName: "Developer", roles: ["DEVELOPER"],
  }));
  const createdReviewer = await service.createAccount(administrator, {
    username: "reviewer", displayName: "Reviewer", roles: ["REVIEWER"],
  });
  const reviewer = reviewerNeedsPasswordChange
    ? { accountId: createdReviewer.account.id }
    : await activateAccount(createdReviewer);
  return {
    service, password, administrator, reviewer,
    reviewerPassword: reviewerNeedsPasswordChange ? createdReviewer.temporaryPassword : password,
  };
}

async function loginReviewer(page, runtime) {
  const sockets = new Set();
  page.on("websocket", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  runtime.openBrowserSockets = sockets;
  await page.goto(runtime.shareUrl);
  await expect(page).toHaveURL(new RegExp(`^${runtime.controlUrl.replaceAll(".", "\\.")}/login\\?intent=`));
  await page.getByLabel("아이디", { exact: true }).fill("reviewer");
  await page.getByLabel("비밀번호", { exact: true }).fill(runtime.reviewerPassword);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  if (runtime.reviewerNeedsPasswordChange) {
    await expect(page.getByRole("heading", { name: "비밀번호 변경", exact: true })).toBeVisible();
    await page.getByLabel("현재 비밀번호", { exact: true }).fill(runtime.reviewerPassword);
    await page.getByLabel("새 비밀번호", { exact: true }).fill(runtime.passwordAfterChange);
    await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(runtime.passwordAfterChange);
    await page.getByRole("button", { name: "변경", exact: true }).click();
  }
  await expect(page).toHaveURL(runtime.shareUrl);
  const cookies = await page.context().cookies();
  const contentSession = cookies.find((cookie) => cookie.name === "rt_session_dev");
  const controlSession = cookies.find((cookie) => cookie.name === "rt_control_dev");
  expect(contentSession?.domain).toBe(new URL(runtime.shareUrl).hostname);
  expect(controlSession?.domain).toBe("control.localhost");
  expect(contentSession?.httpOnly).toBe(true);
  expect(controlSession?.httpOnly).toBe(true);
}

async function verifyReviewerRevocation(page, runtime) {
  expect(runtime.openBrowserSockets.size).toBeGreaterThan(0);
  await runtime.revokeReviewer();
  await expect.poll(() => runtime.openBrowserSockets.size).toBe(0);
  const status = await page.evaluate(async () => (await fetch("/?revocation-check", {
    cache: "no-store", headers: { accept: "application/json" },
  })).status);
  expect(status).toBe(401);
  await page.goto(runtime.shareUrl);
  await expect(page.getByRole("heading", { name: "Review Tunnel 로그인" })).toBeVisible();
}

function startFramework(kind, fixtureDirectory, port) {
  const executable = kind === "vite"
    ? join(repositoryRoot, "node_modules", "vite", "bin", "vite.js")
    : join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
  const args = kind === "vite"
    ? [executable, fixtureDirectory, "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
    : [executable, "dev", fixtureDirectory, "--hostname", "127.0.0.1", "--port", String(port)];
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" },
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
      await response.body?.cancel();
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
