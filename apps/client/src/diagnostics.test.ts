import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { diagnoseClient, explainClientFailure, type DiagnosticCheck } from "./diagnostics.ts";
import { parseClientArguments } from "./cli-options.ts";

const options = parseClientArguments(["http://127.0.0.1:3000", "--username", "developer"], {});

test("doctor checks independent failures without printing server errors or prompting on an unavailable server", async () => {
  const checks: DiagnosticCheck[] = [];
  let prompted = false;
  const ok = await diagnoseClient({ options,
    report: check => checks.push(check),
    probeLocal: async () => { throw new Error("ECONNREFUSED secret-local-data"); },
    fetchImplementation: async () => { throw new Error("server-secret"); },
    readPassword: async () => { prompted = true; return "password"; },
  });
  assert.equal(ok, false);
  assert.deepEqual(checks.map(check => check.status), ["fail", "fail", "skip"]);
  assert.equal(prompted, false);
  assert.doesNotMatch(JSON.stringify(checks), /secret/);
});

test("doctor logs out its temporary session after checking developer credentials and never opens a carrier", async () => {
  const requests: string[] = [];
  const checks: DiagnosticCheck[] = [];
  const ok = await diagnoseClient({ options,
    report: check => checks.push(check), probeLocal: async () => "127.0.0.1", readPassword: async () => "password",
    fetchImplementation: async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      assert.equal(init?.redirect, "error");
      if (path === "/health/ready") return new Response(null, { status: 200 });
      if (path === "/api/client/login") return Response.json({ sessionToken: "private-session-token" });
      if (path === "/api/carrier-credentials") return Response.json({ credential: "private-credential", tunnelId: "id" });
      assert.equal(path, "/api/client/logout");
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(requests, ["/health/ready", "/api/client/login", "/api/carrier-credentials", "/api/client/logout"]);
  assert.deepEqual(checks.map(check => check.status), ["pass", "pass", "pass"]);
  assert.doesNotMatch(JSON.stringify(checks), /private-/);
});

test("doctor distinguishes invalid credentials and cleanup failures", async () => {
  for (const failure of ["login", "logout"]) {
    const checks: DiagnosticCheck[] = [];
    const ok = await diagnoseClient({ options, report: check => checks.push(check), probeLocal: async () => "127.0.0.1", readPassword: async () => "password",
      fetchImplementation: async url => {
        const path = new URL(String(url)).pathname;
        if (path === "/health/ready") return new Response(null, { status: 200 });
        if (path === "/api/client/login") return failure === "login" ? Response.json({ error: "INVALID_CREDENTIALS" }, { status: 401 }) : Response.json({ sessionToken: "token" });
        if (path === "/api/carrier-credentials") return Response.json({ credential: "credential", tunnelId: "id" });
        return new Response(null, { status: 503 });
      },
    });
    assert.equal(ok, false);
    assert.match(checks.at(-1)!.message, failure === "login" ? /아이디와 비밀번호/ : /세션을 종료/);
  }
  assert.match(explainClientFailure(new Error("FORBIDDEN"), "account"), /DEVELOPER/);
});

test("doctor CLI probes a real local server, exits on failure, and needs no password for basic checks", async () => {
  let status = 200;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(status).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env };
  delete env.REVIEW_TUNNEL_USERNAME; delete env.CONTROL_URL; delete env.GATEWAY_URL;
  const execute = promisify(execFile);
  const args = ["--experimental-strip-types", "apps/client/src/main.ts", "doctor", `http://127.0.0.1:${address.port}`, "--gateway", `ws://127.0.0.1:${address.port}/_review-tunnel/carrier`];
  const options = { cwd: new URL("../../../", import.meta.url), env, timeout: 10_000 };
  try {
    const { stdout } = await execute(process.execPath, args, options);
    assert.match(stdout, /✓ 로컬 웹앱/);
    assert.match(stdout, /✓ 공유 서버/);
    assert.match(stdout, /– 개발자 계정/);
    assert.match(stdout, /공유를 시작하지 않습니다/);
    status = 503;
    await assert.rejects(execute(process.execPath, args, options), (error: unknown) => {
      assert.ok(error && typeof error === "object" && "code" in error && "stdout" in error);
      assert.equal(error.code, 1);
      assert.match(String(error.stdout), /DB 연결 상태/);
      return true;
    });
    assert.deepEqual(paths, ["/health/ready", "/health/ready"]);
    const help = await execute(process.execPath, ["--experimental-strip-types", "apps/client/src/main.ts", "doctor", "--help"], options);
    assert.match(help.stdout, /Diagnose: review-tunnel doctor/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
