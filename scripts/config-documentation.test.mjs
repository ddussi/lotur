import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const documentedOperationalSettings = [
  "DATABASE_CONNECT_TIMEOUT_MS",
  "DATABASE_QUERY_TIMEOUT_MS",
  "REVIEW_EVENT_POLL_INTERVAL_MS",
  "REVIEW_EVENT_HEARTBEAT_INTERVAL_MS",
  "REVIEW_EVENT_RETRY_MS",
  "MAX_REVIEW_EVENT_CONNECTIONS",
  "MAX_REVIEW_EVENT_CONNECTIONS_PER_ACCOUNT",
  "MAX_REVIEW_EVENTS",
  "REVIEW_EVENT_RETENTION_MS",
  "MAX_PENDING_TUNNELS",
  "MAX_ACTIVE_TUNNELS",
  "MAX_TUNNELS_PER_ACCOUNT",
  "LOGIN_INTENTS_PER_SOURCE_PER_MINUTE",
  "LOGIN_INTENTS_GLOBAL_PER_MINUTE",
  "MAX_CONCURRENT_LOGIN_ATTEMPTS",
  "MAX_CONCURRENT_LOGIN_ATTEMPTS_PER_REMOTE",
  "LOGIN_ATTEMPTS_PER_MINUTE",
  "LOGIN_ATTEMPTS_PER_REMOTE_PER_MINUTE",
  "MAX_CONCURRENT_WEB_AUTHORIZATIONS",
  "MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE",
  "TRUSTED_PROXY_CIDRS",
  "MAX_FORWARDED_FOR_ENTRIES",
  "MAX_OUTSTANDING_CARRIER_CREDENTIALS",
  "MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT",
  "CARRIER_CREDENTIALS_PER_MINUTE",
  "CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE",
  "MAX_AUTH_SESSIONS",
  "MAX_AUTH_SESSIONS_PER_ACCOUNT",
  "MAX_SESSION_EXCHANGES",
  "MAX_SESSION_EXCHANGES_PER_ACCOUNT",
  "MAX_LOGIN_THROTTLES",
  "MAX_AUDIT_EVENTS",
  "AUDIT_OPERATIONAL_RESERVE",
  "MAX_PENDING_CARRIER_FRAMES",
  "MAX_PENDING_CARRIER_BYTES",
  "MAX_CANARY_WEBSOCKETS",
  "CANARY_WEBSOCKET_IDLE_TIMEOUT_MS",
  "MAX_REQUEST_BODY_BYTES",
  "MAX_FINITE_RESPONSE_BYTES",
  "MAX_CONCURRENT_STREAMS",
  "MAX_NEW_STREAMS_PER_MINUTE",
  "RESPONSE_HEADER_TIMEOUT_MS",
  "STREAM_INACTIVITY_TIMEOUT_MS",
  "MAX_STREAM_DURATION_MS",
  "HEARTBEAT_INTERVAL_MS",
  "CARRIER_LEASE_MS",
  "AUTHORIZATION_MAX_AGE_MS",
  "REVOCATION_CHECK_INTERVAL_MS",
];

const authenticatedRequiredSettings = [
  "CONTENT_DOMAIN",
  "PUBLIC_CONTENT_ORIGIN",
  "CONTROL_HOST",
  "DATABASE_URL",
  "AUTH_SESSION_HMAC_KEY",
  "DEPLOYMENT_ID",
  "DEPLOYMENT_CONFIG_DIGEST",
  "CANARY_HOST",
  "CANARY_BEARER_TOKEN",
];

test("운영 timeout과 admission 상한은 example env와 배포 문서에 함께 노출한다", async () => {
  const [exampleEnvironment, deploymentGuide] = await Promise.all([
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../docs/linux-deployment.md", import.meta.url), "utf8"),
  ]);
  const environmentTable = deploymentGuide.slice(
    deploymentGuide.indexOf("| 이름 | 기본값·설명 |"),
    deploymentGuide.indexOf("\n\n", deploymentGuide.indexOf("| 이름 | 기본값·설명 |")),
  );

  for (const name of documentedOperationalSettings) {
    assert.match(
      exampleEnvironment,
      new RegExp(`^# ${name}=`, "m"),
      `${name} is missing from .env.example`,
    );
    assert.ok(environmentTable.includes(`| \`${name}\` |`), `${name} is outside the environment table`);
  }
});

test("인증형 Gateway 시작 안내는 런타임 필수 설정을 모두 포함한다", async () => {
  const [exampleEnvironment, gettingStarted] = await Promise.all([
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../docs/getting-started.md", import.meta.url), "utf8"),
  ]);

  for (const name of authenticatedRequiredSettings) {
    assert.match(exampleEnvironment, new RegExp(`^# ${name}=`, "m"), `${name} is missing from .env.example`);
    assert.ok(gettingStarted.includes(`${name}=`), `${name} is missing from the first-time guide`);
  }
  for (const command of ["verify:public-path", "record-canary", "approve-admission", "admission-status"]) {
    assert.ok(gettingStarted.includes(command), `${command} is missing from the first-time guide`);
  }
});
