import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewTunnelScriptProps, withReviewTunnel } from "./index.ts";

test("Next integration immutably merges controlled development origins", () => {
  const original = { reactStrictMode: true, allowedDevOrigins: ["existing.example"] };
  const configured = withReviewTunnel(original, {
    allowedDevOrigins: ["*.tunnel.example", "existing.example"],
  });
  assert.notEqual(configured, original);
  assert.deepEqual(configured.allowedDevOrigins, ["existing.example", "*.tunnel.example"]);
  assert.deepEqual(original.allowedDevOrigins, ["existing.example"]);
});

test("Next integration requires explicit controlled origins", () => {
  assert.throws(() => withReviewTunnel({}, { allowedDevOrigins: [] }), /allowedDevOrigins/);
});

test("Next integration exposes explicit development-only root-layout bootstrap props", () => {
  const developmentProps = reviewTunnelScriptProps(true);
  assert.deepEqual(developmentProps, {
    src: "/_review-tunnel/review/bootstrap.js",
    type: "module",
    strategy: "afterInteractive",
  });
  assert.equal(Object.isFrozen(developmentProps), true);
  assert.deepEqual(reviewTunnelScriptProps(true, "request-nonce"), {
    ...developmentProps,
    nonce: "request-nonce",
  });
  assert.equal(Object.isFrozen(reviewTunnelScriptProps(true, "request-nonce")), true);
  assert.equal(reviewTunnelScriptProps(false), undefined);
  assert.deepEqual(
    withReviewTunnel({ reactStrictMode: true }, { allowedDevOrigins: [], enabled: false }),
    { reactStrictMode: true },
  );
});
