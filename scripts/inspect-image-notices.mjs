import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_TARGETS, sha256 } from "./release-artifacts.mjs";
import { verifyImageRecord } from "./candidate-images.mjs";
import { checkReleaseVersions } from "./release-version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { tag: { type: "string", default: "ci" }, record: { type: "string" }, output: { type: "string", default: "dist/image-notices.json" } } });
assert.match(values.tag, /^[a-zA-Z0-9_.-]+$/);
const execute = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60_000, stdio: ["pipe", "pipe", "pipe"], ...options });
const revision = execute("git", ["rev-parse", "HEAD"]).trim();
const version = (await checkReleaseVersions(root)).version;
const selected = values.record ? JSON.parse(await readFile(resolve(values.record), "utf8")) : undefined;
if (selected) verifyImageRecord(selected, { revision, version, repository: selected.repository });
const probe = await readFile(new URL("./image-notices-probe.mjs", import.meta.url), "utf8");
const projectDigest = sha256(await readFile(new URL("../LICENSE", import.meta.url)));
const images = [];
for (const target of RUNTIME_TARGETS) {
  const reference = selected?.images.find(item => item.target === target)?.reference ?? `review-tunnel-${target}:${values.tag}`;
  const inspected = JSON.parse(execute("docker", ["image", "inspect", reference]))[0];
  assert.equal(inspected.Config.Labels?.["org.opencontainers.image.revision"], revision, `${target} source revision does not match this checkout`);
  // Every command runs the inspected local identity, without network or writes.
  const inventory = JSON.parse(execute("docker", ["run", "--rm", "-i", "--network", "none", "--read-only", "--entrypoint", "node", inspected.Id, "--input-type=module"], { input: probe }));
  assert.equal(inventory.projectNotice.sha256, projectDigest, `${target} project license differs`);
  for (const item of inventory.npmPackages.flatMap(item => item.notices).filter(item => item.path.startsWith("/app/third-party-notices/"))) {
    assert.equal(item.sha256, sha256(await readFile(resolve(root, item.path.slice("/app/".length)))), `${target} redistribution notice differs from this checkout`);
  }
  if (images.length) assert.equal(inventory.nodeNotice.sha256, images[0].inventory.nodeNotice.sha256, `${target} Node.js notices differ`);
  if (["db-backup", "db-restore"].includes(target)) {
    assert.equal(inventory.npmPackages.length, 0);
    assert.ok(inventory.osPackages.some(item => item.name === "postgresql-client-17"));
  } else assert.ok(inventory.npmPackages.length > 0);
  images.push({ target, reference, id: inspected.Id, platform: `${inspected.Os}/${inspected.Architecture}`, inventory });
  console.log(`${target}: ${inventory.osPackages.length} Debian packages, ${inventory.npmPackages.length} npm packages; Node.js and project notices present.`);
}
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ format: "review-tunnel-image-notices-v1", sourceRevision: revision, version, images }, null, 2)}\n`, { flag: "wx" });
console.log("All six runtime notice inventories verified.");
