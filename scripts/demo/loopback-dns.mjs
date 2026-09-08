// Explicit preload for demo child processes; never change system DNS or hosts.
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const originalLookup = dns.lookup;
dns.lookup = function demoLookup(hostname, options, callback) {
  const normalized = typeof hostname === "string" ? hostname.toLowerCase().replace(/\.$/, "") : "";
  if (normalized !== "control.localhost" && normalized !== "preview.localhost" &&
    !normalized.endsWith(".preview.localhost")) {
    return originalLookup.call(dns, hostname, options, callback);
  }
  const done = typeof options === "function" ? options : callback;
  const settings = typeof options === "object" && options !== null ? options : {};
  const family = (typeof options === "number" ? options : settings.family) === 6 ? 6 : 4;
  const address = family === 6 ? "::1" : "127.0.0.1";
  queueMicrotask(() => {
    if (settings.all) done(null, [{ address, family }]);
    else done(null, address, family);
  });
};
dns.promises.lookup = (hostname, options) => new Promise((resolve, reject) => {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) reject(error);
    else resolve(Array.isArray(address) ? address : { address, family });
  });
});
syncBuiltinESMExports();
