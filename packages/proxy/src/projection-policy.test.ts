import assert from "node:assert/strict";
import test from "node:test";

import {
  projectRequestHeaders,
  projectResponseHeaders,
} from "./projection-policy.ts";

const reserved = new Set(["__Host-rt_session", "rt_session_dev"]);

test("local-view는 공개 same-origin 값을 로컬 origin으로 일관되게 투영한다", () => {
  const projected = projectRequestHeaders([
    ["Host", "demo.preview.example"],
    ["Origin", "https://demo.preview.example"],
    ["Referer", "https://demo.preview.example/form?q=1"],
    ["Forwarded", "for=attacker;host=evil.example"],
    ["X-Forwarded-Host", "evil.example"],
    ["Authorization", "Bearer application-token"],
  ], {
    originProjection: "local-view",
    localOrigin: "http://127.0.0.1:3000",
    publicOrigin: "https://demo.preview.example",
  });

  assert.deepEqual(projected, [
    ["Origin", "http://127.0.0.1:3000"],
    ["Referer", "http://127.0.0.1:3000/form?q=1"],
    ["Authorization", "Bearer application-token"],
    ["Host", "127.0.0.1:3000"],
  ]);
});

test("proxy-aware는 공격자 forwarding 값을 버리고 공개 origin 기준 값을 생성한다", () => {
  const projected = projectRequestHeaders([
    ["Host", "attacker.example"],
    ["X-Forwarded-Proto", "http"],
  ], {
    originProjection: "proxy-aware",
    localOrigin: "http://127.0.0.1:3000",
    publicOrigin: "https://demo.preview.example",
  });

  assert.deepEqual(projected, [
    ["Host", "demo.preview.example"],
    ["Forwarded", 'host="demo.preview.example";proto=https'],
    ["X-Forwarded-Host", "demo.preview.example"],
    ["X-Forwarded-Proto", "https"],
    ["X-Forwarded-Port", "443"],
  ]);
});

test("응답은 local Location을 공유 origin으로 바꾸고 위험한 Domain cookie를 폐기한다", () => {
  const projected = projectResponseHeaders([
    ["Location", "http://127.0.0.1:3000/next?q=1"],
    ["Refresh", "0; url='http://127.0.0.1:3000/refresh'"],
    ["Set-Cookie", "app=one; Domain=127.0.0.1; Path=/; HttpOnly"],
    ["Set-Cookie", "parent=bad; Domain=example.com; Path=/"],
    ["Set-Cookie", "__Host-rt_session=bad; Secure; Path=/"],
    ["Set-Cookie", "hostonly=ok; Path=/; SameSite=Lax"],
  ], {
    originProjection: "local-view",
    localOrigin: "http://127.0.0.1:3000",
    publicOrigin: "https://demo.preview.example",
    reservedCookieNames: reserved,
  });

  assert.deepEqual(projected, [
    ["Location", "https://demo.preview.example/next?q=1"],
    ["Refresh", "0; url='https://demo.preview.example/refresh'"],
    ["Set-Cookie", "app=one; Path=/; HttpOnly"],
    ["Set-Cookie", "hostonly=ok; Path=/; SameSite=Lax"],
  ]);
});
