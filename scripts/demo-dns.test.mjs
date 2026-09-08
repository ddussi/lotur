import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("demo DNS resolves only its localhost namespace and leaves other lookups unchanged", () => {
  // Stub the system resolver before the explicit preload to verify delegation
  // without querying the network or depending on the machine's DNS settings.
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import dns from 'node:dns';
    dns.lookup = (hostname, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      queueMicrotask(() => done(null, '192.0.2.1', 4));
    };
    await import(${JSON.stringify(new URL("./demo/loopback-dns.mjs", import.meta.url).href)});
    const { lookup } = await import('node:dns/promises');
    const hosts = ['CONTROL.localhost.', 'preview.localhost', 'canary.preview.localhost',
      'share.preview.localhost', 'unrelated.localhost', 'control.localhost.example.com'];
    console.log(JSON.stringify({
      addresses: await Promise.all(hosts.map(host => lookup(host))),
      all: await lookup('control.localhost', { all: true }),
      ipv6: await lookup('control.localhost', { family: 6 }),
    }));
  `], { encoding: "utf8" });
  const result = JSON.parse(output);
  assert.deepEqual(result.addresses.slice(0, 4), Array(4).fill({ address: "127.0.0.1", family: 4 }));
  assert.deepEqual(result.addresses.slice(4), Array(2).fill({ address: "192.0.2.1", family: 4 }));
  assert.deepEqual(result.all, [{ address: "127.0.0.1", family: 4 }]);
  assert.deepEqual(result.ipv6, { address: "::1", family: 6 });
});
