import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, cp, mkdir, unlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RELEASE_FORMAT, releaseFiles, packageFiles, sha256, verifyRelease } from "./release-artifacts.mjs";
import { checkReleaseVersions } from "./release-version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const revision = "a".repeat(40);
async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-release-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const version = "0.1.0-alpha.1";
  const assets = [];
  for (const file of releaseFiles(version)) {
    const bytes = Buffer.from(`Synthetic integrity fixture: ${file}\n`);
    await writeFile(join(directory, file), bytes);
    assets.push({ file, sha256: sha256(bytes), bytes: bytes.length });
  }
  const manifest = { format: RELEASE_FORMAT, version, tag: `v${version}`, source: { revision, tree: "b".repeat(40) }, packages: packageFiles(version), assets };
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify(manifest));
  const sums = [...assets.map(asset => `${asset.sha256}  ${asset.file}`), `${sha256(await readFile(join(directory, "release-manifest.json")))}  release-manifest.json`];
  await writeFile(join(directory, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return { directory, manifest };
}

test("release integrity rejects changed bytes, the wrong commit and unlisted files", async context => {
  const { directory, manifest } = await fixture(context);
  assert.equal((await verifyRelease(directory, revision)).version, manifest.version);
  await assert.rejects(verifyRelease(directory, "c".repeat(40)), /expected commit/);
  await writeFile(join(directory, "private-config.json"), "unexpected");
  await assert.rejects(verifyRelease(directory, revision), /unlisted files/);
  await unlink(join(directory, "private-config.json"));
  await writeFile(join(directory, manifest.assets[0].file), "Changed archive bytes");
  await assert.rejects(verifyRelease(directory, revision), /Checksum mismatch/);
});

test("release integrity rejects symlinked artifacts and duplicate checksum entries", async context => {
  const { directory, manifest } = await fixture(context);
  const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  await writeFile(join(directory, "SHA256SUMS"), `${sums}${sums.split("\n")[0]}\n`);
  await assert.rejects(verifyRelease(directory, revision), /duplicate/);
  await writeFile(join(directory, "SHA256SUMS"), sums);
  await unlink(join(directory, manifest.assets[0].file));
  await symlink(join(directory, "LICENSE"), join(directory, manifest.assets[0].file));
  await assert.rejects(verifyRelease(directory, revision), /regular files/);
});

test("release version gate catches a stale workspace dependency and Docker lockfile", async context => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-release-versions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const actual = await checkReleaseVersions(root);
  for (const name of ["package.json", "package-lock.json"]) await cp(join(root, name), join(directory, name));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  for (const path of [...Object.keys(lock.packages).filter(path => /^(apps|packages)\//.test(path)), "deploy/runtime"]) {
    await mkdir(join(directory, path), { recursive: true });
    await cp(join(root, path, "package.json"), join(directory, path, "package.json"));
  }
  await cp(join(root, "deploy/runtime/package-lock.json"), join(directory, "deploy/runtime/package-lock.json"));
  assert.equal((await checkReleaseVersions(directory)).version, actual.version);
  const clientPath = join(directory, "apps/client/package.json");
  const clientText = await readFile(clientPath, "utf8");
  const client = JSON.parse(clientText); client.dependencies["@review-tunnel/protocol"] = "0.0.0";
  await writeFile(clientPath, JSON.stringify(client));
  await assert.rejects(checkReleaseVersions(directory), /workspace dependency/);
  await writeFile(clientPath, clientText);
  const runtimePath = join(directory, "deploy/runtime/package-lock.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf8")); runtime.packages[""].version = "0.0.0";
  await writeFile(runtimePath, JSON.stringify(runtime));
  await assert.rejects(checkReleaseVersions(directory), /Docker runtime/);
});
