import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSessionConfigMetadata,
  createSessionConfigSnapshot,
  digestSessionConfig,
  encodeCanonicalSessionConfig,
} from "./session-config.ts";

const fingerprint = "A".repeat(43);

test("Session configuration은 고정 canonical bytes와 digest를 만든다", () => {
  const snapshot = createSessionConfigSnapshot({
    generation: 3,
    localOriginFingerprint: fingerprint,
    originProjection: "local-view",
    publicOrigin: "https://demo.preview.example",
    initialConnectionWindowBytes: 256 * 1024,
    initialStreamWindowBytes: 64 * 1024,
  });
  const digest = digestSessionConfig(snapshot);

  assert.equal(digest.length, 43);
  assert.equal(
    new TextDecoder().decode(encodeCanonicalSessionConfig(snapshot)),
    '{"generation":3,"idleTimeoutMs":1800000,"initialConnectionWindowBytes":262144,"initialStreamWindowBytes":65536,"localOriginFingerprint":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","maxConcurrentStreams":128,"maxFiniteResponseBytes":67108864,"maxNewStreamsPerMinute":600,"maxRequestBodyBytes":16777216,"maxStreamDurationMs":14400000,"maxTtlMs":28800000,"originProjection":"local-view","profile":"review-tunnel.v1","publicOrigin":"https://demo.preview.example","reconnectGraceMs":120000,"responseHeaderTimeoutMs":10000,"streamInactivityTimeoutMs":120000}',
  );
  assert.doesNotThrow(() =>
    assertSessionConfigMetadata({ revision: 4, digest, snapshot }),
  );
});

test("snapshot 변경이나 잘못된 제한은 fail-closed한다", () => {
  const snapshot = createSessionConfigSnapshot({
    generation: 1,
    localOriginFingerprint: fingerprint,
    originProjection: "proxy-aware",
    publicOrigin: "https://demo.preview.example",
    initialConnectionWindowBytes: 256 * 1024,
    initialStreamWindowBytes: 64 * 1024,
  });
  assert.throws(() =>
    assertSessionConfigMetadata({
      revision: 1,
      digest: digestSessionConfig(snapshot),
      snapshot: { ...snapshot, generation: 2 },
    }),
    /digest does not match/,
  );
  assert.throws(() =>
    createSessionConfigSnapshot({
      generation: 1,
      localOriginFingerprint: fingerprint,
      originProjection: "local-view",
      publicOrigin: "https://demo.preview.example",
      initialConnectionWindowBytes: 0,
      initialStreamWindowBytes: 64 * 1024,
    }),
    /initialConnectionWindowBytes/,
  );
});
