import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewTunnel } from "./index.ts";

test("Vite integration is serve-only and injects through the official HTML hook", () => {
  const plugin = reviewTunnel();
  assert.equal(plugin.name, "review-tunnel");
  assert.equal(plugin.apply, "serve");
  assert.equal(typeof plugin.transformIndexHtml, "function");
  assert.equal(Object.hasOwn(plugin, "configureServer"), false);
});

test("Vite overlay injection never owns the Tunnel process lifecycle", () => {
  const plugin = reviewTunnel();
  assert.equal(plugin.name, "review-tunnel");
  assert.equal(typeof plugin.transformIndexHtml, "function");
  assert.equal(Object.hasOwn(plugin, "closeBundle"), false);
});

test("Vite integration forwards an explicit CSP nonce to the bootstrap script", () => {
  const plugin = reviewTunnel({ nonce: "request-nonce" });
  const transform = plugin.transformIndexHtml as unknown as () => Array<{
    attrs: Record<string, string>;
  }>;
  assert.equal(transform()[0]?.attrs.nonce, "request-nonce");
});
