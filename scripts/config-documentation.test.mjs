import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const documentedOperationalSettings = [
  "DATABASE_CONNECT_TIMEOUT_MS",
  "DATABASE_QUERY_TIMEOUT_MS",
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
];

test("운영 timeout과 admission 상한은 example env와 배포 문서에 함께 노출한다", async () => {
  const [exampleEnvironment, deploymentGuide] = await Promise.all([
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../docs/linux-deployment.md", import.meta.url), "utf8"),
  ]);

  for (const name of documentedOperationalSettings) {
    assert.match(
      exampleEnvironment,
      new RegExp(`^# ${name}=`, "m"),
      `${name} is missing from .env.example`,
    );
    assert.ok(
      deploymentGuide.includes(`| \`${name}\` |`),
      `${name} is missing from docs/linux-deployment.md`,
    );
  }
});
