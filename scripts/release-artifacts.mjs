import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { VERSION_PATTERN } from "./release-version.mjs";

export const RELEASE_FORMAT = "review-tunnel-release-v1";
export const RUNTIME_TARGETS = ["gateway", "admin-cli", "client", "canary-check", "db-backup", "db-restore"];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const packageFiles = version => ["client", "vite", "next"].map(name => ({
  name: `@review-tunnel/${name}`, version, file: `review-tunnel-${name}-${version}.tgz`,
}));
export function releaseFiles(version) {
  return [...packageFiles(version).map(item => item.file), `review-tunnel-${version}-source.tar.gz`, "LICENSE", "CHANGELOG.md"];
}

export async function verifyRelease(directory, expectedRevision) {
  const entries = await readdir(directory);
  for (const name of entries) {
    if (!(await lstat(join(directory, name))).isFile()) throw new Error("Release artifacts must be regular files, without directories or symlinks.");
  }
  const manifest = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"));
  if (manifest.format !== RELEASE_FORMAT || !VERSION_PATTERN.test(manifest.version) || manifest.tag !== `v${manifest.version}`) {
    throw new Error("Unrecognized release manifest or version.");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.source?.revision ?? "") || !/^[a-f0-9]{40}$/.test(manifest.source?.tree ?? "")) {
    throw new Error("Release source must name an exact Git commit and tree.");
  }
  if (expectedRevision !== undefined && manifest.source.revision !== expectedRevision) throw new Error("Release source does not match the expected commit.");
  const expected = releaseFiles(manifest.version).sort();
  if (JSON.stringify(manifest.assets?.map(asset => asset.file).sort()) !== JSON.stringify(expected) ||
      JSON.stringify(manifest.packages) !== JSON.stringify(packageFiles(manifest.version))) {
    throw new Error("Release asset/package inventory differs from the required distribution.");
  }
  const all = [...expected, "release-manifest.json", "SHA256SUMS"].sort();
  if (JSON.stringify(entries.sort()) !== JSON.stringify(all)) throw new Error("Release directory contains missing or unlisted files.");
  const sums = new Map();
  for (const line of (await readFile(join(directory, "SHA256SUMS"), "utf8")).trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error("Invalid or duplicate SHA256SUMS entry.");
    sums.set(match[2], match[1]);
  }
  if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(all.filter(name => name !== "SHA256SUMS"))) {
    throw new Error("Checksum inventory differs from release files.");
  }
  for (const [name, digest] of sums) {
    const bytes = await readFile(join(directory, name));
    if (sha256(bytes) !== digest) throw new Error(`Checksum mismatch: ${name}`);
    const declared = manifest.assets.find(asset => asset.file === name);
    if (declared && (declared.sha256 !== digest || declared.bytes !== bytes.length)) throw new Error(`Manifest integrity mismatch: ${name}`);
  }
  return manifest;
}
