import assert from "node:assert/strict";
import test from "node:test";

import { parseClientArguments, safeLocalOriginForDisplay } from "./cli-options.ts";

test("실제로 사용하는 client 옵션만 strict하게 파싱한다", () => {
  const options = parseClientArguments([
    "http://127.0.0.1:3000",
    "--gateway", "wss://gateway.example/_review-tunnel/carrier",
    "--control-url", "https://gateway.example",
    "--username", "developer",
    "--password-stdin",
  ], {});
  assert.equal(options.localOrigin, "http://127.0.0.1:3000");
  assert.equal(options.gatewayUrl, "wss://gateway.example/_review-tunnel/carrier");
  assert.equal(options.controlUrl, "https://gateway.example");
  assert.match(options.tunnelId, /^[a-f0-9]{32}$/);
  assert.equal(options.username, "developer");
  assert.equal(options.passwordStdin, true);
});

test("unknown, 중복, 추가 positional 옵션을 조용히 무시하지 않는다", () => {
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--review-port", "443",
  ], {}), /unknown option/);
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--gateway", "ws://one.example/carrier",
    "--gateway", "ws://two.example/carrier",
  ], {}), /only be provided once/);
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "extra",
  ], {}), /unexpected positional/);
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--tunnel-id", "INVALID_TUNNEL",
  ], {}), /tunnel-id is invalid/);
});

test("표시용 local origin에는 URL userinfo가 포함되지 않는다", () => {
  assert.equal(
    safeLocalOriginForDisplay("http://alice:plain-secret@127.0.0.1:3000"),
    "http://127.0.0.1:3000",
  );
});

test("인증 없이 무시될 인증 옵션과 서버가 덮어쓸 tunnel ID를 fail-closed한다", () => {
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--password-stdin",
  ], {}), /password-stdin.*username/);
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--control-url", "https://control.example",
  ], {}), /control-url.*username/);
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--username", "developer",
    "--tunnel-id", "ignored-tunnel",
  ], {}), /tunnel-id.*authenticated/i);

  assert.equal(parseClientArguments([
    "http://127.0.0.1:3000",
    "--password-stdin",
  ], { REVIEW_TUNNEL_USERNAME: "developer" }).passwordStdin, true);
});

test("Gateway carrier URL과 Control origin 계약을 strict하게 검증한다", () => {
  for (const gateway of [
    "wss://gateway.example/other",
    "wss://gateway.example/other/../_review-tunnel/carrier",
    "wss://gateway.example/_review-tunnel/carrier?token=secret",
    "wss://gateway.example/_review-tunnel/carrier?",
    "wss://gateway.example/_review-tunnel/carrier#fragment",
    "wss://alice:secret@gateway.example/_review-tunnel/carrier",
  ]) {
    assert.throws(() => parseClientArguments([
      "http://127.0.0.1:3000",
      "--gateway", gateway,
    ], {}), /Gateway URL is invalid/);
  }

  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--username", "developer",
    "--control-url", "https://control.example/base?tenant=one",
  ], {}), /Control URL is invalid/);
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--username", "developer",
    "--control-url", "https://control.example/base/..",
  ], {}), /Control URL is invalid/);
  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--username", "developer",
    "--control-url", "https://control.example/?",
  ], {}), /Control URL is invalid/);
  assert.equal(parseClientArguments([
    "http://127.0.0.1:3000",
    "--username", "developer",
    "--gateway", "wss://control.example/_review-tunnel/carrier",
    "--control-url", "https://control.example/",
  ], {}).controlUrl, "https://control.example");
});

test("인증 mode는 password와 Carrier credential을 동일한 secure endpoint에만 보낸다", () => {
  for (const arguments_ of [
    [
      "http://127.0.0.1:3000",
      "--username", "developer",
      "--gateway", "wss://carrier.example/_review-tunnel/carrier",
      "--control-url", "https://control.example",
    ],
    [
      "http://127.0.0.1:3000",
      "--username", "developer",
      "--gateway", "wss://control.example:8443/_review-tunnel/carrier",
      "--control-url", "https://control.example:9443",
    ],
    [
      "http://127.0.0.1:3000",
      "--username", "developer",
      "--gateway", "wss://control.example/_review-tunnel/carrier",
      "--control-url", "http://control.example",
    ],
  ]) {
    assert.throws(
      () => parseClientArguments(arguments_, {}),
      /same origin mapping|HTTPS and WSS/,
    );
  }

  assert.throws(() => parseClientArguments([
    "http://127.0.0.1:3000",
    "--username", "developer",
    "--gateway", "ws://control.example/_review-tunnel/carrier",
    "--control-url", "http://control.example",
  ], {}), /HTTPS and WSS/);

  const loopback = parseClientArguments([
    "http://127.0.0.1:3000",
    "--username", "developer",
    "--gateway", "ws://127.0.0.1:8787/_review-tunnel/carrier",
    "--control-url", "http://127.0.0.1:8787",
  ], {});
  assert.equal(loopback.controlUrl, "http://127.0.0.1:8787");
});
