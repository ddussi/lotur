import assert from "node:assert/strict";
import test from "node:test";

import { readGatewayConfig } from "./config.ts";

test("POC Gateway는 기본적으로 loopback localhost content domain만 사용한다", () => {
  assert.deepEqual(readGatewayConfig({}), {
    host: "127.0.0.1",
    port: 8787,
    contentDomain: "localhost",
    secureCookies: true,
    autoMigrate: true,
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
      secureCookies: true,
      autoMigrate: true,
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
