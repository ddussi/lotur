import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [join(root, "apps"), join(root, "packages")];
const violations = [];

for (const sourceRoot of sourceRoots) {
  for (const file of await listTypeScriptFiles(sourceRoot)) {
    if (file.endsWith(".test.ts")) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      const target = normalize(resolve(dirname(file), specifier));
      enforceBoundary(file, target);
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries: OK");
}

async function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function enforceBoundary(source, target) {
  const sourcePath = relative(root, source).split(sep).join("/");
  const targetPath = relative(root, target).split(sep).join("/");

  if (sourcePath.startsWith("packages/") && targetPath.startsWith("apps/")) {
    violations.push(`${sourcePath} must not depend on ${targetPath}`);
  }

  if (
    sourcePath.startsWith("packages/protocol/") &&
    targetPath.startsWith("packages/") &&
    !targetPath.startsWith("packages/protocol/")
  ) {
    violations.push(`${sourcePath} protocol core must not depend on ${targetPath}`);
  }

  if (
    sourcePath.startsWith("packages/relay/") &&
    targetPath.startsWith("packages/") &&
    !targetPath.startsWith("packages/relay/") &&
    !targetPath.startsWith("packages/protocol/")
  ) {
    violations.push(`${sourcePath} relay core must not depend on ${targetPath}`);
  }

  if (
    sourcePath.startsWith("packages/auth/") &&
    targetPath.startsWith("packages/") &&
    !targetPath.startsWith("packages/auth/")
  ) {
    violations.push(`${sourcePath} auth core must not depend on ${targetPath}`);
  }

  if (
    sourcePath.startsWith("packages/storage-postgres/") &&
    targetPath.startsWith("packages/") &&
    !targetPath.startsWith("packages/storage-postgres/") &&
    !targetPath.startsWith("packages/auth/")
  ) {
    violations.push(`${sourcePath} PostgreSQL adapter must only depend on auth core`);
  }

  if (
    sourcePath.startsWith("apps/client/") &&
    (targetPath.startsWith("packages/auth/") || targetPath.startsWith("packages/storage-postgres/"))
  ) {
    violations.push(`${sourcePath} Client must authenticate through control API, not server auth internals`);
  }
}
