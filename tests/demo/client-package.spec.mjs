import { test, expect } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixture, login } from "./runtime.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));

test("installed Client shares, reconnects at the same URL and cleans up failed review binding", async ({ page }, testInfo) => {
  const demo = await fixture();
  const consumer = await mkdtemp(join(tmpdir(), "review-tunnel-client-browser-"));
  let proxy;
  let client;
  let output = "";
  let closed;
  const environment = { PATH: process.env.PATH, HOME: consumer,
    npm_config_cache: join(consumer, "empty-cache"), npm_config_audit: "false", npm_config_fund: "false",
    npm_config_userconfig: join(consumer, "empty-npmrc"), npm_config_globalconfig: join(consumer, "empty-global-npmrc"),
    npm_config_registry: "http://127.0.0.1:1" };
  async function stop() {
    if (!client || client.exitCode !== null || client.signalCode !== null) return;
    client.kill("SIGINT");
    await expect.poll(() => client.exitCode, { timeout: 20_000 }).not.toBeNull();
    expect((await closed)[0]).toBe(0);
  }
  try {
    await writeFile(environment.npm_config_userconfig, ""); await writeFile(environment.npm_config_globalconfig, "");
    await writeFile(join(consumer, "package.json"), '{"name":"client-browser-consumer","private":true,"type":"module"}');
    const archiveDirectory = join(consumer, "archives"); await mkdir(archiveDirectory);
    const { stdout: packed } = await execute(process.execPath, ["scripts/pack-client.mjs", "--output-dir", archiveDirectory], { cwd: root, env: environment });
    await execute("npm", ["install", "--offline", "--ignore-scripts", packed.trim()], { cwd: consumer, env: environment });
    // The local-only demo name mapping is a consumer-side fixture, not a package dependency.
    await cp(join(root, "scripts/demo/loopback-dns.mjs"), join(consumer, "local-dns.mjs"));
    await cp(join(root, "tests/demo/terminal-client.py"), join(consumer, "terminal-client.py"));
    const ready = await demo.start();
    const config = JSON.parse(await readFile(join(demo.directory, "config.json"), "utf8"));
    proxy = await createControlProxy(config);
    const arguments_ = ["--import", "./local-dns.mjs", "./node_modules/.bin/review-tunnel",
      `http://127.0.0.1:${config.appPort}`, "--gateway", `ws://control.localhost:${proxy.port}/_review-tunnel/carrier`,
      "--username", "developer",
      "--review-project", "standalone-client", "--review-revision", "package-check"];
    client = spawn("python3", ["terminal-client.py"], { cwd: consumer, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    closed = once(client, "exit");
    client.stdout.on("data", bytes => { output += bytes; }); client.stderr.on("data", bytes => { output += bytes; });
    client.stdin.end(`${JSON.stringify({ executable: process.execPath, arguments: [process.execPath, ...arguments_], password: ready.accounts.developer.password })}\n`);
    await expect.poll(() => {
      if (client.exitCode !== null) throw new Error(`Installed Client exited ${client.exitCode}: ${output.replaceAll(ready.accounts.developer.password, "[redacted]")}`);
      return output.match(/Tunnel ready: (\S+)/)?.[1];
    }, { timeout: 20_000 }).toBeTruthy();
    const shareUrl = output.match(/Tunnel ready: (\S+)/)[1];
    expect(output).toContain("Review Tunnel password: ");
    await login(page, shareUrl, ready.accounts.reviewer);
    await expect(page.getByRole("heading", { name: "A calmer way to launch." })).toBeVisible();
    const overlay = page.locator("review-tunnel-overlay");
    await expect(overlay).toContainText("standalone-client");
    await overlay.getByRole("textbox", { name: "Comment", exact: true }).fill("Saved through the installed Client.");
    await overlay.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(overlay.locator(".thread")).toContainText("Saved through the installed Client.");
    const permalink = await overlay.getByRole("link", { name: "Permanent link" }).getAttribute("href");
    proxy.dropCarrier();
    await expect.poll(() => output, { timeout: 20_000 }).toContain("Carrier reconnected; the existing share URL is active again");
    await page.reload();
    expect(page.url()).toBe(shareUrl);
    await expect(overlay.locator(".thread")).toContainText("Saved through the installed Client.");
    await stop();
    await page.goto(permalink);
    await expect(page.locator(".thread")).toContainText("Saved through the installed Client.");
    await expect(page.getByRole("link", { name: /^앱에서 보기/ })).toHaveCount(0);
    expect(output).not.toContain(ready.accounts.developer.password);

    const rejected = await createControlProxy(config, true);
    try {
      const failure = spawn(process.execPath, ["--import", "./local-dns.mjs", "./node_modules/.bin/review-tunnel", `http://127.0.0.1:${config.appPort}`,
        "--gateway", `ws://control.localhost:${rejected.port}/_review-tunnel/carrier`,
        "--username", "developer", "--password-stdin", "--review-project", "test-project", "--review-revision", "test-revision"],
      { cwd: consumer, env: environment, stdio: ["pipe", "pipe", "pipe"] });
      let failureOutput = "";
      failure.stdout.on("data", bytes => { failureOutput += bytes; }); failure.stderr.on("data", bytes => { failureOutput += bytes; });
      failure.stdin.end(`${ready.accounts.developer.password}\n`);
      const failureExit = once(failure, "exit");
      await expect.poll(() => failure.exitCode, { timeout: 20_000 }).toBe(1);
      await failureExit;
      expect(failureOutput).not.toContain("Tunnel ready:");
      expect(rejected.loggedOut()).toBe(true);
      await expect.poll(() => rejected.carrierCount()).toBe(0);
      const metrics = await page.request.get(`http://127.0.0.1:${config.gatewayPort}/metrics`, { headers: { host: `control.localhost:${config.gatewayPort}`, authorization: `Bearer ${config.metricsToken}` } });
      expect(metrics.ok()).toBe(true);
      expect(await metrics.text()).toMatch(/review_tunnel_active_tunnels 1\b/);
      expect(rejected.bindingRejected()).toBe(true);
    } finally { await rejected.close(); }
  } finally {
    await testInfo.attach("installed-client-output", { body: output, contentType: "text/plain" });
    await stop();
    await proxy?.close();
    await page.close(); await demo.close(); await rm(consumer, { recursive: true, force: true });
  }
});

async function createControlProxy(config, rejectBinding = false) {
  const { createServer: createHttpServer, request: send } = await import("node:http");
  let logout = false, bindingRejected = false;
  const sockets = new Set();
  const server = createHttpServer((request, response) => {
    if (rejectBinding && request.url.startsWith("/api/client/review-bindings/")) {
      bindingRejected = true;
      request.resume(); response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "REVIEW_BINDING_CONFLICT" })); return;
    }
    const upstream = send({ host: "127.0.0.1", port: config.gatewayPort, path: request.url,
      method: request.method, headers: { ...request.headers, host: `control.localhost:${config.gatewayPort}` } }, result => {
      if (request.url === "/api/client/logout" && result.statusCode >= 200 && result.statusCode < 300) logout = true;
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  server.on("upgrade", (request, downstream, head) => {
    const upstream = connect({ host: "127.0.0.1", port: config.gatewayPort });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { downstream.destroy(); upstream.destroy(); });
    }
    const headers = { ...request.headers, host: `control.localhost:${config.gatewayPort}` };
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
      Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    downstream.pipe(upstream).pipe(downstream);
    downstream.on("close", () => upstream.destroy()); upstream.on("close", () => downstream.destroy());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const dropCarrier = () => { for (const socket of sockets) socket.destroy(); };
  return { port: server.address().port, loggedOut: () => logout, bindingRejected: () => bindingRejected,
    dropCarrier, carrierCount: () => sockets.size,
    close: async () => { dropCarrier(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
