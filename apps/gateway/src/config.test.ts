import assert from "node:assert/strict";
import test from "node:test";

import { readGatewayConfig } from "./config.ts";

test("POC Gateway는 기본적으로 loopback localhost content domain만 사용한다", () => {
  assert.deepEqual(readGatewayConfig({}), {
    host: "127.0.0.1",
    port: 8787,
    contentDomain: "localhost",
    secureCookies: false,
    autoMigrate: true,
    initialKillSwitch: false,
    gatewayAdmissionReady: true,
  });
});

test("인증 없는 POC의 외부 bind는 기본 거부한다", () => {
  assert.throws(() => readGatewayConfig({ GATEWAY_HOST: "0.0.0.0" }));
});

test("외부 bind opt-in과 environment domain을 명시적으로 검증한다", () => {
  assert.deepEqual(
    readGatewayConfig({
      GATEWAY_HOST: "0.0.0.0",
      GATEWAY_PORT: "8080",
      CONTENT_DOMAIN: "review.internal.example",
      ALLOW_INSECURE_POC: "true",
    }),
    {
      host: "0.0.0.0",
      port: 8080,
      contentDomain: "review.internal.example",
      secureCookies: false,
      autoMigrate: true,
      initialKillSwitch: false,
      gatewayAdmissionReady: false,
    },
  );
});

test("내부 계정 모드는 DB, control host와 32-byte HMAC key를 함께 요구한다", () => {
  const key = Buffer.alloc(32, 9).toString("base64url");
  const config = readGatewayConfig({
    GATEWAY_HOST: "0.0.0.0",
    CONTENT_DOMAIN: "preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://lotur@example.invalid/lotur",
    AUTH_SESSION_HMAC_KEY: key,
  });
  assert.equal(config.controlHost, "control.example.net");
  assert.equal(config.authSessionHmacKey?.byteLength, 32);
  assert.throws(() => readGatewayConfig({ DATABASE_URL: "postgres://example.invalid/db" }));
  assert.throws(() => readGatewayConfig({
    CONTENT_DOMAIN: "preview.example.com",
    CONTROL_HOST: "control.example.com",
    DATABASE_URL: "postgres://example.invalid/db",
    AUTH_SESSION_HMAC_KEY: key,
  }), /different browser site boundaries/);
});

test("metrics token과 초기 kill switch를 명시적으로 검증한다", () => {
  const token = "m".repeat(32);
  const config = readGatewayConfig({
    METRICS_BEARER_TOKEN: token,
    KILL_SWITCH_ENABLED: "true",
  });
  assert.equal(config.metricsBearerToken, token);
  assert.equal(config.initialKillSwitch, true);
  assert.throws(
    () => readGatewayConfig({ METRICS_BEARER_TOKEN: "too-short" }),
    /at least 32/,
  );
});

test("운영 limit과 lease 값은 양의 정수만 허용한다", () => {
  const config = readGatewayConfig({
    MAX_REQUEST_BODY_BYTES: "4096",
    MAX_CONCURRENT_STREAMS: "12",
    HEARTBEAT_INTERVAL_MS: "1000",
    CARRIER_LEASE_MS: "3000",
    REVOCATION_CHECK_INTERVAL_MS: "500",
  });
  assert.deepEqual(config.sessionLimits, {
    maxRequestBodyBytes: 4096,
    maxConcurrentStreams: 12,
  });
  assert.equal(config.heartbeatIntervalMs, 1000);
  assert.equal(config.carrierLeaseMs, 3000);
  assert.equal(config.authorizationCheckIntervalMs, 500);
  assert.throws(
    () => readGatewayConfig({ MAX_CONCURRENT_STREAMS: "0" }),
    /positive integer/,
  );
});

test("이전 HMAC key는 active key와 함께 rotation window에만 주입한다", () => {
  const active = Buffer.alloc(32, 1).toString("base64url");
  const previous = Buffer.alloc(32, 2).toString("base64url");
  const config = readGatewayConfig({
    CONTENT_DOMAIN: "preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://example.invalid/db",
    AUTH_SESSION_HMAC_KEY: active,
    AUTH_SESSION_HMAC_KEY_PREVIOUS: previous,
  });
  assert.equal(config.authSessionHmacPreviousKeys?.[0]?.byteLength, 32);
  assert.throws(
    () => readGatewayConfig({ AUTH_SESSION_HMAC_KEY_PREVIOUS: previous }),
    /requires AUTH_SESSION_HMAC_KEY/,
  );
});
