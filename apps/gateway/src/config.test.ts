import assert from "node:assert/strict";
import test from "node:test";

import { readGatewayConfig } from "./config.ts";

const deploymentEnvironment = {
  DEPLOYMENT_ID: "release-42",
  DEPLOYMENT_CONFIG_DIGEST: `sha256:${"d".repeat(64)}`,
  CANARY_HOST: "canary.preview.example.com",
  CANARY_BEARER_TOKEN: "c".repeat(32),
};

test("POC Gateway는 기본적으로 loopback localhost content domain만 사용한다", () => {
  assert.deepEqual(readGatewayConfig({}), {
    host: "127.0.0.1",
    port: 8787,
    contentDomain: "localhost",
    secureCookies: false,
    autoMigrate: false,
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
      autoMigrate: false,
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
    PUBLIC_CONTENT_ORIGIN: "https://preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://lotur@example.invalid/lotur",
    AUTH_SESSION_HMAC_KEY: key,
    ...deploymentEnvironment,
  });
  assert.equal(config.controlHost, "control.example.net");
  assert.equal(config.publicContentOrigin, "https://preview.example.com");
  assert.equal(config.authSessionHmacKey?.byteLength, 32);
  assert.throws(() => readGatewayConfig({ DATABASE_URL: "postgres://example.invalid/db" }));
  assert.throws(() => readGatewayConfig({
    CONTENT_DOMAIN: "preview.example.com",
    PUBLIC_CONTENT_ORIGIN: "https://preview.example.com",
    CONTROL_HOST: "control.example.com",
    DATABASE_URL: "postgres://example.invalid/db",
    AUTH_SESSION_HMAC_KEY: key,
    ...deploymentEnvironment,
  }), /different browser site boundaries/);
});

test("인증 모드는 listener와 분리된 canonical public content origin을 요구한다", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const authenticated = {
    GATEWAY_HOST: "0.0.0.0",
    CONTENT_DOMAIN: "preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://lotur@example.invalid/lotur",
    AUTH_SESSION_HMAC_KEY: key,
    ...deploymentEnvironment,
  };

  assert.throws(
    () => readGatewayConfig(authenticated),
    /PUBLIC_CONTENT_ORIGIN is required/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      PUBLIC_CONTENT_ORIGIN: "https://other.example.com",
    }),
    /must match CONTENT_DOMAIN/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      PUBLIC_CONTENT_ORIGIN: "https://preview.example.com/path",
    }),
    /canonical HTTP origin/,
  );

  const nonstandard = readGatewayConfig({
    ...authenticated,
    PUBLIC_CONTENT_ORIGIN: "https://preview.example.com:8443",
  });
  assert.equal(nonstandard.publicContentOrigin, "https://preview.example.com:8443");
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
  assert.throws(
    () => readGatewayConfig({ METRICS_BEARER_TOKEN: "m".repeat(513) }),
    /at most 512/,
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

test("부수효과 boolean은 strict하게 해석하고 migration은 opt-in이다", () => {
  assert.equal(readGatewayConfig({}).autoMigrate, false);
  assert.equal(readGatewayConfig({ AUTO_MIGRATE: "true" }).autoMigrate, true);
  assert.throws(
    () => readGatewayConfig({ AUTO_MIGRATE: "yes" }),
    /AUTO_MIGRATE must be either true or false/,
  );
  assert.throws(
    () => readGatewayConfig({ ALLOW_INSECURE_POC: "TRUE" }),
    /ALLOW_INSECURE_POC must be either true or false/,
  );
  assert.throws(
    () => readGatewayConfig({ KILL_SWITCH_ENABLED: "1" }),
    /KILL_SWITCH_ENABLED must be either true or false/,
  );
});

test("인증 운영 설정은 HTTPS public origin과 bounded timeout·quota를 강제한다", () => {
  const key = Buffer.alloc(32, 5).toString("base64url");
  const authenticated = {
    GATEWAY_HOST: "0.0.0.0",
    CONTENT_DOMAIN: "preview.example.com",
    PUBLIC_CONTENT_ORIGIN: "https://preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://lotur@example.invalid/lotur",
    AUTH_SESSION_HMAC_KEY: key,
    ...deploymentEnvironment,
  };

  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      PUBLIC_CONTENT_ORIGIN: "http://preview.example.com",
    }),
    /HTTPS/,
  );
  assert.throws(
    () => readGatewayConfig({ ...authenticated, DATABASE_QUERY_TIMEOUT_MS: "2147483648" }),
    /at most 2147483647/,
  );
  assert.throws(
    () => readGatewayConfig({ ...authenticated, MAX_TUNNELS_PER_ACCOUNT: "0" }),
    /positive integer/,
  );

  const config = readGatewayConfig({
    ...authenticated,
    DATABASE_CONNECT_TIMEOUT_MS: "1200",
    DATABASE_QUERY_TIMEOUT_MS: "900",
    MAX_PENDING_TUNNELS: "7",
    MAX_ACTIVE_TUNNELS: "20",
    MAX_TUNNELS_PER_ACCOUNT: "3",
    LOGIN_INTENTS_PER_SOURCE_PER_MINUTE: "11",
    LOGIN_INTENTS_GLOBAL_PER_MINUTE: "120",
    MAX_CONCURRENT_LOGIN_ATTEMPTS: "8",
    MAX_CONCURRENT_LOGIN_ATTEMPTS_PER_REMOTE: "2",
    MAX_CONCURRENT_WEB_AUTHORIZATIONS: "16",
    MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE: "4",
    LOGIN_ATTEMPTS_PER_MINUTE: "90",
    LOGIN_ATTEMPTS_PER_REMOTE_PER_MINUTE: "12",
    TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 2001:db8:ffff::/48",
    MAX_FORWARDED_FOR_ENTRIES: "8",
    MAX_OUTSTANDING_CARRIER_CREDENTIALS: "30",
    MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT: "4",
    CARRIER_CREDENTIALS_PER_MINUTE: "100",
    CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE: "10",
    MAX_AUTH_SESSIONS: "5000",
    MAX_AUTH_SESSIONS_PER_ACCOUNT: "50",
    MAX_SESSION_EXCHANGES: "900",
    MAX_SESSION_EXCHANGES_PER_ACCOUNT: "30",
    MAX_LOGIN_THROTTLES: "4000",
    MAX_AUDIT_EVENTS: "8000",
    AUDIT_OPERATIONAL_RESERVE: "500",
    MAX_PENDING_CARRIER_FRAMES: "48",
    MAX_PENDING_CARRIER_BYTES: "524408",
    MAX_CANARY_WEBSOCKETS: "3",
    CANARY_WEBSOCKET_IDLE_TIMEOUT_MS: "12000",
  });
  assert.equal(config.databaseConnectionTimeoutMs, 1200);
  assert.equal(config.databaseQueryTimeoutMs, 900);
  assert.equal(config.maxPendingTunnels, 7);
  assert.equal(config.maxActiveTunnels, 20);
  assert.equal(config.maxTunnelsPerAccount, 3);
  assert.equal(config.loginIntentsPerSourcePerMinute, 11);
  assert.equal(config.loginIntentsGlobalPerMinute, 120);
  assert.equal(config.maxConcurrentLoginAttempts, 8);
  assert.equal(config.maxConcurrentLoginAttemptsPerRemote, 2);
  assert.equal(config.maxConcurrentWebAuthorizations, 16);
  assert.equal(config.maxConcurrentWebAuthorizationsPerRemote, 4);
  assert.equal(config.loginAttemptsPerMinute, 90);
  assert.equal(config.loginAttemptsPerRemotePerMinute, 12);
  assert.deepEqual(config.trustedProxyCidrs, ["10.0.0.0/8", "2001:db8:ffff::/48"]);
  assert.equal(config.maxForwardedForEntries, 8);
  assert.equal(config.maxOutstandingCarrierCredentials, 30);
  assert.equal(config.maxOutstandingCarrierCredentialsPerAccount, 4);
  assert.equal(config.carrierCredentialsPerMinute, 100);
  assert.equal(config.carrierCredentialsPerAccountPerMinute, 10);
  assert.equal(config.maxAuthSessions, 5000);
  assert.equal(config.maxAuthSessionsPerAccount, 50);
  assert.equal(config.maxSessionExchanges, 900);
  assert.equal(config.maxSessionExchangesPerAccount, 30);
  assert.equal(config.maxLoginThrottles, 4000);
  assert.equal(config.maxAuditEvents, 8000);
  assert.equal(config.auditOperationalReserve, 500);
  assert.equal(config.maxPendingCarrierFrames, 48);
  assert.equal(config.maxPendingCarrierBytes, 524408);
  assert.equal(config.maxCanaryWebSockets, 3);
  assert.equal(config.canaryWebSocketIdleTimeoutMs, 12000);
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      MAX_AUTH_SESSIONS: "10",
      MAX_AUTH_SESSIONS_PER_ACCOUNT: "11",
    }),
    /MAX_AUTH_SESSIONS_PER_ACCOUNT.*MAX_AUTH_SESSIONS/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      MAX_SESSION_EXCHANGES: "10",
      MAX_SESSION_EXCHANGES_PER_ACCOUNT: "11",
    }),
    /MAX_SESSION_EXCHANGES_PER_ACCOUNT.*MAX_SESSION_EXCHANGES/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      MAX_CONCURRENT_WEB_AUTHORIZATIONS: "2",
      MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE: "3",
    }),
    /MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE.*MAX_CONCURRENT_WEB_AUTHORIZATIONS/,
  );
  assert.throws(
    () => readGatewayConfig({ ...authenticated, TRUSTED_PROXY_CIDRS: "10.0.0.0/33" }),
    /CIDR prefix/,
  );
  assert.throws(
    () => readGatewayConfig({ ...authenticated, MAX_LOGIN_THROTTLES: "1" }),
    /MAX_LOGIN_THROTTLES must be at least 2/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      MAX_AUDIT_EVENTS: "20",
      AUDIT_OPERATIONAL_RESERVE: "20",
    }),
    /AUDIT_OPERATIONAL_RESERVE must be less than MAX_AUDIT_EVENTS/,
  );
  assert.throws(
    () => readGatewayConfig({ ...authenticated, TRUSTED_PROXY_CIDRS: "10.0.0.0/8," }),
    /non-empty CIDRs/,
  );
  assert.throws(
    () => readGatewayConfig({ ...authenticated, MAX_FORWARDED_FOR_ENTRIES: "8" }),
    /requires TRUSTED_PROXY_CIDRS/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      MAX_PENDING_CARRIER_BYTES: "65550",
    }),
    /at least 65551/,
  );
});

test("이전 HMAC key는 active key와 함께 rotation window에만 주입한다", () => {
  const active = Buffer.alloc(32, 1).toString("base64url");
  const previous = Buffer.alloc(32, 2).toString("base64url");
  const previousTwo = Buffer.alloc(32, 3).toString("base64url");
  const previousThree = Buffer.alloc(32, 4).toString("base64url");
  const previousFour = Buffer.alloc(32, 5).toString("base64url");
  const authenticated = {
    CONTENT_DOMAIN: "preview.example.com",
    PUBLIC_CONTENT_ORIGIN: "https://preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://example.invalid/db",
    AUTH_SESSION_HMAC_KEY: active,
    ...deploymentEnvironment,
  };
  const config = readGatewayConfig({
    ...authenticated,
    AUTH_SESSION_HMAC_KEY_PREVIOUS: previous,
  });
  assert.equal(config.authSessionHmacPreviousKeys?.[0]?.byteLength, 32);
  assert.throws(
    () => readGatewayConfig({ AUTH_SESSION_HMAC_KEY_PREVIOUS: previous }),
    /requires AUTH_SESSION_HMAC_KEY/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      AUTH_SESSION_HMAC_KEY_PREVIOUS:
        [previous, previousTwo, previousThree, previousFour].join(","),
    }),
    /at most 3 previous HMAC keys/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      AUTH_SESSION_HMAC_KEY_PREVIOUS: `${previous},${active}`,
    }),
    /HMAC keys must be unique/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      AUTH_SESSION_HMAC_KEY: Buffer.alloc(129, 6).toString("base64url"),
    }),
    /at most 128 bytes/,
  );
});

test("인증 운영 모드는 배포 identity를 요구하고 메모리 admission·kill env를 거부한다", () => {
  const key = Buffer.alloc(32, 6).toString("base64url");
  const authenticated = {
    CONTENT_DOMAIN: "preview.example.com",
    PUBLIC_CONTENT_ORIGIN: "https://preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://example.invalid/db",
    AUTH_SESSION_HMAC_KEY: key,
  };
  assert.throws(() => readGatewayConfig(authenticated), /DEPLOYMENT_ID/);
  const config = readGatewayConfig({ ...authenticated, ...deploymentEnvironment });
  assert.deepEqual(config.deploymentIdentity, {
    deploymentId: "release-42",
    configDigest: `sha256:${"d".repeat(64)}`,
  });
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      ...deploymentEnvironment,
      GATEWAY_ADMISSION_READY: "true",
    }),
    /PostgreSQL operational state/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      ...deploymentEnvironment,
      KILL_SWITCH_ENABLED: "true",
    }),
    /PostgreSQL operational state/,
  );
});

test("인증 운영 모드는 콘텐츠 domain 안의 전용 authenticated canary host를 요구한다", () => {
  const key = Buffer.alloc(32, 8).toString("base64url");
  const authenticated = {
    CONTENT_DOMAIN: "preview.example.com",
    PUBLIC_CONTENT_ORIGIN: "https://preview.example.com",
    CONTROL_HOST: "control.example.net",
    DATABASE_URL: "postgres://example.invalid/db",
    AUTH_SESSION_HMAC_KEY: key,
    DEPLOYMENT_ID: "release-42",
    DEPLOYMENT_CONFIG_DIGEST: `sha256:${"e".repeat(64)}`,
  };
  assert.throws(() => readGatewayConfig(authenticated), /CANARY_HOST/);
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      CANARY_HOST: "canary.other.example.com",
      CANARY_BEARER_TOKEN: "c".repeat(32),
    }),
    /subdomain of CONTENT_DOMAIN/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      CANARY_HOST: "canary.preview.example.com",
      CANARY_BEARER_TOKEN: "short",
    }),
    /at least 32/,
  );
  assert.throws(
    () => readGatewayConfig({
      ...authenticated,
      CANARY_HOST: "canary.preview.example.com",
      CANARY_BEARER_TOKEN: "c".repeat(513),
    }),
    /at most 512/,
  );
});
