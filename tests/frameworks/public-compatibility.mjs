import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { createCarrierAuthentication } from '../../apps/client/src/control-client.ts';
import { connectTunnelClient } from '../../apps/client/src/client.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const accessFile = process.env.PUBLIC_TEST_ACCESS_FILE;
assert.ok(accessFile, 'PUBLIC_TEST_ACCESS_FILE must point to a private JSON file with controlUrl, gatewayUrl and dedicated admin/developer/reviewer accounts');
const access = JSON.parse(await readFile(accessFile, 'utf8'));
const outputDirectory = await mkdtemp(join(tmpdir(), 'lotur-public-frameworks-'));
const kinds = process.argv.length > 2 ? process.argv.slice(2) : ['vite', 'next'];
assert.ok(kinds.every(kind => kind === 'vite' || kind === 'next'), 'Frameworks must be vite or next');
console.log(`Test artifacts: ${outputDirectory}`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const kind of kinds) await runFramework(kind);
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(results, null, 2));
  console.log('PASS: All public HTTPS browser tests completed');
} finally {
  await browser.close();
}

async function runFramework(kind) {
  const directory = await mkdtemp(join(root, `tests/frameworks/.runtime-public-${kind}-`));
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostics = [];
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') diagnostics.push(message.text()); });
  page.on('pageerror', error => diagnostics.push(error.message));
  page.on('requestfailed', request => diagnostics.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  let framework;
  let client;
  let authentication;
  const steps = [];
  const passed = (step) => { steps.push(step); console.log(`PASS ${kind}: ${step}`); };
  try {
    await cp(join(root, 'tests/frameworks/fixtures', kind), directory, { recursive: true });
    const port = await reservePort();
    framework = startFramework(kind, directory, port);
    await waitForHttp(`http://127.0.0.1:${port}/`, framework);
    authentication = await createCarrierAuthentication({
      controlUrl: access.controlUrl,
      username: access.accounts.developer.username,
      password: access.accounts.developer.password,
    });
    const input = {
      gatewayUrl: access.gatewayUrl,
      localOrigin: `http://127.0.0.1:${port}`,
      tunnelId: authentication.tunnelId,
      carrierCredential: authentication.carrierCredential,
    };
    client = connectTunnelClient(input);
    const active = await client.ready;
    passed('Developer API login and WSS tunnel activation');
    console.log(`Public test URL (${kind}): ${active.shareUrl}`);

    const sockets = new Set();
    page.on('websocket', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await page.goto(active.shareUrl);
    await expect(page.getByRole('heading', { name: 'Review Tunnel 로그인' })).toBeVisible({ timeout: 15000 });
    assert.equal(new URL(page.url()).origin, access.controlUrl);
    passed('Unauthenticated browser redirected to control-host login');
    await login(page, access.accounts.reviewer);
    await expect(page).toHaveURL(active.shareUrl, { timeout: 15000 });
    const cookies = await context.cookies();
    const control = cookies.find(cookie => cookie.name === '__Host-rt_control');
    const content = cookies.find(cookie => cookie.name === '__Host-rt_session');
    assert.equal(control?.domain, new URL(access.controlUrl).hostname);
    assert.equal(content?.domain, new URL(active.shareUrl).hostname);
    assert.ok(control?.secure && control.httpOnly && content?.secure && content.httpOnly);
    passed('Browser login with isolated Secure and HttpOnly cookies');

    if (kind === 'vite') {
      await expect(page.getByRole('heading', { name: 'Vite through Review Tunnel' })).toBeVisible({ timeout: 20000 });
      await page.getByTestId('counter').click();
      await expect(page.getByTestId('counter')).toHaveText('count: 1');
      const sourcePath = join(directory, 'src/main.js');
      const source = await readFile(sourcePath, 'utf8');
      await writeFile(sourcePath, source.replace('vite-hmr-v1', 'vite-hmr-v2'));
      await expect(page.getByTestId('hmr-marker')).toHaveText('vite-hmr-v2', { timeout: 20000 });
      passed('Page interaction and HMR over public HTTPS');

      await client.disconnect();
      const carrierCredential = await authentication.issueResumeCredential('resume', active.tunnelId, AbortSignal.timeout(10000));
      client = connectTunnelClient({ ...input, carrierCredential, resumeSecret: active.resumeSecret, pinnedLocalAddress: active.pinnedLocalAddress });
      const resumed = await client.ready;
      assert.equal(resumed.shareUrl, active.shareUrl);
      assert.ok(resumed.generation > active.generation);
      await page.reload();
      await expect(page.getByTestId('hmr-marker')).toHaveText('vite-hmr-v2', { timeout: 20000 });
      passed('WSS disconnect and authenticated resume preserve the share URL');
    } else {
      await expect(page.getByRole('heading', { name: 'Next.js through Review Tunnel' })).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('rsc-stream')).toHaveText('next-rsc-stream-ready', { timeout: 30000 });
      assert.equal(await page.evaluate(async () => (await (await fetch('/api/health')).json()).marker), 'next-route-handler-ok');
      await page.getByRole('button', { name: 'run server action' }).click();
      await expect(page.getByTestId('action-result')).toHaveText('server-action-ok', { timeout: 20000 });
      await page.getByTestId('counter').click();
      await expect(page.getByTestId('counter')).toHaveText('count: 1');
      const sourcePath = join(directory, 'app/interactive-fixture.jsx');
      const source = await readFile(sourcePath, 'utf8');
      await writeFile(sourcePath, source.replace('next-fast-refresh-v1', 'next-fast-refresh-v2'));
      await expect(page.getByTestId('refresh-marker')).toHaveText('next-fast-refresh-v2', { timeout: 30000 });
      await expect(page.getByTestId('counter')).toHaveText('count: 1');
      await page.getByTestId('details-link').click();
      await expect(page.getByTestId('details')).toHaveText('next-client-navigation-ok', { timeout: 20000 });
      passed('RSC, API route, Server Action, state-preserving Fast Refresh and navigation');
    }

    await expect.poll(() => sockets.size, { timeout: 10000 }).toBeGreaterThan(0);
    const screenshot = join(outputDirectory, `${kind}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await revokeReviewer();
    await expect.poll(() => sockets.size, { timeout: 15000 }).toBe(0);
    const deniedStatus = await page.evaluate(async () => (await fetch('/?revocation-check', { cache: 'no-store', headers: { accept: 'application/json' } })).status);
    assert.equal(deniedStatus, 401);
    await page.goto(active.shareUrl);
    await expect(page.getByRole('heading', { name: 'Review Tunnel 로그인' })).toBeVisible({ timeout: 15000 });
    passed('Administrator revocation closes HMR and rejects subsequent requests');
    results.push({ framework: kind, shareUrl: active.shareUrl, tunnelClosedAfterTest: true, steps, screenshot, passedAt: new Date().toISOString() });
  } catch (error) {
    await page.screenshot({path: join(outputDirectory, `${kind}-failure.png`), fullPage: true}).catch(() => {});
    console.error('Browser diagnostics:', diagnostics);
    console.error('Framework diagnostics:', framework?.output());
    throw error;
  } finally {
    await context.close();
    await client?.close().catch(() => undefined);
    await authentication?.close().catch(() => undefined);
    if (framework) await stopProcess(framework);
    await rm(directory, { recursive: true, force: true });
  }
}

async function login(page, account) {
  await page.getByLabel('아이디', { exact: true }).fill(account.username);
  await page.getByLabel('비밀번호', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}
async function revokeReviewer() {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${access.controlUrl}/login`);
    await login(page, access.accounts.admin);
    await expect(page.getByRole('heading', { name: '계정 관리', exact: true })).toBeVisible({ timeout: 15000 });
    const row = page.getByRole('row').filter({ has: page.getByText(access.accounts.reviewer.username, { exact: true }) });
    const form = row.locator('form[action$="/revoke"]');
    await form.getByLabel('관리자 비밀번호', { exact: true }).fill(access.accounts.admin.password);
    await form.getByRole('button', { name: '세션 종료', exact: true }).click();
    await expect(page.getByRole('heading', { name: '계정 관리', exact: true })).toBeVisible({ timeout: 15000 });
  } finally { await context.close(); }
}
function startFramework(kind, directory, port) {
  const args = kind === 'vite'
    ? [join(root, 'node_modules/vite/bin/vite.js'), directory, '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : [join(root, 'node_modules/next/dist/bin/next'), 'dev', directory, '--hostname', '127.0.0.1', '--port', String(port)];
  const process = spawn(globalThis.process.execPath, args, { cwd: root, env: { ...globalThis.process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
  process.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
  process.output = () => output;
  return process;
}
async function waitForHttp(url, child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Framework exited: ${child.output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Framework startup timed out: ${child.output()}`);
}
async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.listen(0, '127.0.0.1', resolve); server.once('error', reject); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
