import assert from "node:assert/strict";
import test from "node:test";

import {
  projectRequestHeaders,
  projectResponseHeaders,
  stripUntrustedForwardingHeaders,
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
    ["X-Forwarded-User", "admin"],
    ["X-Forwarded-Client-Cert", "spoofed-cert"],
    ["X-Real-IP", "203.0.113.10"],
    ["True-Client-IP", "203.0.113.11"],
    ["CF-Connecting-IP", "203.0.113.12"],
    ["Client-IP", "203.0.113.13"],
    ["X-Client-IP", "203.0.113.14"],
    ["X-Original-Forwarded-For", "203.0.113.15"],
    ["Fastly-Client-IP", "203.0.113.16"],
    ["Fly-Client-IP", "203.0.113.17"],
    ["X-Cluster-Client-IP", "203.0.113.18"],
    ["X-Appengine-User-IP", "203.0.113.19"],
    ["X-Envoy-External-Address", "203.0.113.20"],
    ["X-ProxyUser-IP", "203.0.113.21"],
    ["CF-Connecting-IPv6", "2001:db8::1"],
    ["CloudFront-Viewer-Address", "203.0.113.22:12345"],
    ["X-Original-Client-IP", "203.0.113.23"],
    ["X-Originating-IP", "203.0.113.24"],
    ["X-Remote-IP", "203.0.113.25"],
    ["X-Remote-Addr", "203.0.113.26"],
    ["X-Azure-ClientIP", "203.0.113.27"],
    ["X-NF-Client-Connection-IP", "203.0.113.28"],
    ["X-Vercel-Forwarded-For", "203.0.113.29"],
    ["Authorization", "Bearer application-token"],
    ["Cookie", "app_session=kept"],
  ], {
    originProjection: "proxy-aware",
    localOrigin: "http://127.0.0.1:3000",
    publicOrigin: "https://demo.preview.example",
  });

  assert.deepEqual(projected, [
    ["Authorization", "Bearer application-token"],
    ["Cookie", "app_session=kept"],
    ["Host", "demo.preview.example"],
    ["Forwarded", 'host="demo.preview.example";proto=https'],
    ["X-Forwarded-Host", "demo.preview.example"],
    ["X-Forwarded-Proto", "https"],
    ["X-Forwarded-Port", "443"],
  ]);
});

test("임의 suffix의 X-Forwarded-*와 Forwarded를 모두 제거한다", () => {
  assert.deepEqual(stripUntrustedForwardingHeaders([
    ["Forwarded", "for=attacker"],
    ["X-Forwarded-User", "admin"],
    ["x-forwarded-client-cert", "spoofed-cert"],
    ["X-Forward", "kept"],
  ]), [
    ["X-Forward", "kept"],
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
