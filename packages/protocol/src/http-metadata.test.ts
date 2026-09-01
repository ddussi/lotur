import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeOpenHttpMetadata,
  decodeResponseHeadersMetadata,
  encodeOpenHttpMetadata,
  encodeMetadata,
} from "./http-metadata.ts";

test("OPEN_HTTP encoder and decoder share header count and path validation", () => {
  const metadata = {
    kind: "HTTP" as const,
    method: "GET",
    path: "/valid?query=1",
    headers: [] as (readonly [string, string])[],
    requestBodyEnded: true,
    initialWindowBytes: 1024,
  };
  for (const count of [255, 256]) {
    const value = { ...metadata, headers: Array.from({ length: count }, () => ["x-test", "value"] as const) };
    assert.deepEqual(decodeOpenHttpMetadata(encodeOpenHttpMetadata(value)), value);
  }
  for (const value of [
    { ...metadata, headers: Array.from({ length: 257 }, () => ["x-test", "value"] as const) },
    { ...metadata, path: "/fragment#invalid" },
    { ...metadata, path: "https://example.test/path" },
    { ...metadata, headers: [["x-test", "value\r\nother: value"]] as const },
  ]) {
    assert.throws(() => encodeOpenHttpMetadata(value));
    assert.throws(() => decodeOpenHttpMetadata(encodeMetadata(value)));
  }
});

test("OPEN_HTTP metadata의 method, raw path, 반복 header와 window를 보존한다", () => {
  assert.deepEqual(
    decodeOpenHttpMetadata(
      encodeMetadata({
        kind: "HTTP",
        method: "CUSTOM-METHOD",
        path: "/path?value=%ED%95%9C%EA%B8%80",
        headers: [
          ["X-Value", "one"],
          ["X-Value", "two"],
        ],
        requestBodyEnded: false,
        initialWindowBytes: 65_536,
      }),
    ),
    {
      kind: "HTTP",
      method: "CUSTOM-METHOD",
      path: "/path?value=%ED%95%9C%EA%B8%80",
      headers: [
        ["X-Value", "one"],
        ["X-Value", "two"],
      ],
      requestBodyEnded: false,
      initialWindowBytes: 65_536,
    },
  );
});

test("header value의 CR/LF injection을 거부한다", () => {
  assert.throws(() =>
    decodeResponseHeadersMetadata(
      encodeMetadata({
        statusCode: 101,
        statusMessage: "Switching Protocols",
        headers: [["Upgrade", "websocket\r\nX-Injected: yes"]],
      }),
    ),
  );
});

test("공백·fragment·제어 문자가 있는 request target을 거부한다", () => {
  for (const path of ["/has space", "/fragment#value", "/line\nbreak"]) {
    assert.throws(() =>
      decodeOpenHttpMetadata(
        encodeMetadata({
          kind: "HTTP",
          method: "GET",
          path,
          headers: [],
          requestBodyEnded: true,
          initialWindowBytes: 1024,
        }),
      ),
    );
  }
});
