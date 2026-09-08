import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const readJson = async path => JSON.parse(await readFile(path, "utf8"));

export async function checkReleaseVersions(root) {
  const manifests = new Map([["", await readJson(join(root, "package.json"))]]);
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
      if (entry.isDirectory()) manifests.set(`${group}/${entry.name}`, await readJson(join(root, group, entry.name, "package.json")));
    }
  }
  const version = manifests.get("").version;
  if (!VERSION_PATTERN.test(version)) throw new Error("Release version must be major.minor.patch with an optional alpha, beta or rc number.");
  const names = new Set([...manifests.values()].map(manifest => manifest.name));
  if (names.size !== manifests.size) throw new Error("Package names must be unique.");
  const rootLock = await readJson(join(root, "package-lock.json"));
  if (rootLock.version !== version) throw new Error("Root lockfile version differs from the release version.");
  for (const [path, manifest] of manifests) {
    const label = path || "root";
    const locked = rootLock.packages[path];
    if (manifest.version !== version || locked?.version !== version) throw new Error(`${label} manifest/lockfile version differs from ${version}.`);
    if (manifest.license !== "MIT" || locked?.license !== "MIT") throw new Error(`${label} is missing its project license metadata.`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, declared] of Object.entries(manifest[field] ?? {})) {
        if (names.has(name) && (declared !== version || locked?.[field]?.[name] !== version)) {
          throw new Error(`${label} must pin workspace dependency ${name} to ${version} in its manifest and lockfile.`);
        }
      }
    }
  }
  const runtime = await readJson(join(root, "deploy/runtime/package.json"));
  const runtimeLock = await readJson(join(root, "deploy/runtime/package-lock.json"));
  if ([runtime.version, runtimeLock.version, runtimeLock.packages[""]?.version].some(value => value !== version)) {
    throw new Error("Docker runtime manifest/lockfile version differs from the release version.");
  }
  return { version, packages: [...manifests.values()].map(manifest => ({ name: manifest.name, version: manifest.version })) };
}
