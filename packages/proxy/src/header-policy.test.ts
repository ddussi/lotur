import assert from "node:assert/strict";
import test from "node:test";

import {
  headerPairsToOutgoingHeaders,
  isolateGatewayCredentials,
  rawHeadersToPairs,
  sanitizeHopByHopHeaders,
} from "./header-policy.ts";

test("표준 및 Connection이 지목한 hop-by-hop header를 제거한다", () => {
  assert.deepEqual(
    sanitizeHopByHopHeaders([
      ["Connection", "keep-alive, X-Internal-Hop"],
      ["Keep-Alive", "timeout=5"],
      ["X-Internal-Hop", "remove-me"],
      ["X-App", "preserve-me"],
    ]),
    [["X-App", "preserve-me"]],
  );
});

test("Gateway 예약 쿠키와 내부 header만 격리하고 앱 자격증명은 보존한다", () => {
  const reserved = new Set(["__Host-rt_session", "rt_session_dev"]);
  assert.deepEqual(
    isolateGatewayCredentials([
      ["Cookie", "app_session=abc; __Host-rt_session=gateway; theme=dark"],
      ["Authorization", "Bearer application-token"],
      ["X-Review-Tunnel-Identity", "internal"],
      ["Set-Cookie", "__Host-rt_session=attacker; Path=/; Secure"],
      ["Set-Cookie", "app_session=new; Path=/"],
    ], reserved),
    [
      ["Cookie", "app_session=abc; theme=dark"],
      ["Authorization", "Bearer application-token"],
      ["Set-Cookie", "app_session=new; Path=/"],
    ],
  );
});

test("raw header 순서와 반복 값을 보존해 Node outgoing header로 바꾼다", () => {
  const pairs = rawHeadersToPairs([
    "Set-Cookie",
    "a=1",
    "Set-Cookie",
    "b=2",
  ]);
  assert.deepEqual(pairs, [
    ["Set-Cookie", "a=1"],
    ["Set-Cookie", "b=2"],
  ]);
  assert.deepEqual(headerPairsToOutgoingHeaders(pairs), {
    "set-cookie": ["a=1", "b=2"],
  });
});
