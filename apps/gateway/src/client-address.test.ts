import assert from "node:assert/strict";
import test from "node:test";

import { createClientAddressResolver } from "./client-address.ts";

test("forwarded identity is ignored unless the socket peer is explicitly trusted", () => {
  const resolve = createClientAddressResolver({ trustedProxyCidrs: [] });

  assert.equal(resolve("192.0.2.10", "198.51.100.44"), "192.0.2.10");
  assert.equal(resolve("::ffff:192.0.2.10", "198.51.100.44"), "192.0.2.10");
});

test("a trusted proxy chain resolves from the trusted edge and ignores spoofed left entries", () => {
  const resolve = createClientAddressResolver({
    trustedProxyCidrs: ["10.0.0.0/8", "2001:db8:ffff::/48"],
  });

  assert.equal(
    resolve("10.0.0.8", "198.51.100.250, 203.0.113.9, 10.2.3.4"),
    "203.0.113.9",
  );
  assert.equal(
    resolve("2001:db8:ffff::2", "2001:db8:1234::7, 2001:db8:ffff::1"),
    "2001:db8:1234::7",
  );
});

test("malformed, duplicate, or excessive forwarded chains fall back to stable peer grouping", () => {
  const resolve = createClientAddressResolver({
    trustedProxyCidrs: ["127.0.0.0/8"],
    maxForwardedForEntries: 2,
  });

  assert.equal(resolve("127.0.0.1", "198.51.100.1, not-an-ip"), "127.0.0.1");
  assert.equal(resolve("127.0.0.1", "198.51.100.1, 198.51.100.2, 198.51.100.3"), "127.0.0.1");
  assert.equal(resolve("127.0.0.1", ["198.51.100.1", "198.51.100.2"]), "127.0.0.1");
  assert.equal(resolve("127.0.0.1", "198.51.100.1,"), "127.0.0.1");
});

test("IPv4-mapped IPv6 peers and clients use the same canonical identity and CIDR family", () => {
  const resolve = createClientAddressResolver({
    trustedProxyCidrs: ["127.0.0.0/8", "::1/128", "::ffff:10.0.0.0/104"],
  });

  assert.equal(resolve("::ffff:127.0.0.1", "::ffff:192.0.2.9"), "192.0.2.9");
  assert.equal(resolve("::1", "2001:db8::4"), "2001:db8::4");
  assert.equal(resolve("::ffff:10.2.3.4", "198.51.100.8"), "198.51.100.8");
});

test("trusted CIDRs and forwarded entry limits are strict and bounded", () => {
  assert.throws(
    () => createClientAddressResolver({ trustedProxyCidrs: ["10.0.0.0"] }),
    /CIDR/,
  );
  assert.throws(
    () => createClientAddressResolver({ trustedProxyCidrs: ["10.0.0.0/33"] }),
    /prefix/,
  );
  assert.throws(
    () => createClientAddressResolver({ trustedProxyCidrs: Array(33).fill("10.0.0.0/8") }),
    /at most 32/,
  );
  assert.throws(
    () => createClientAddressResolver({
      trustedProxyCidrs: ["127.0.0.0/8"],
      maxForwardedForEntries: 0,
    }),
    /positive safe integer/,
  );
});
