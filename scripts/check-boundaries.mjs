import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectModuleSpecifiers,
  loadWorkspaceDirectories,
  resolveImportTarget,
} from "./check-boundaries-lib.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(readRootOption() ?? defaultRoot);
const sourceRoots = [join(root, "apps"), join(root, "packages")];
const violations = [];
const workspaceDirectories = await loadWorkspaceDirectories(root);

for (const sourceRoot of sourceRoots) {
  for (const file of await listTypeScriptFiles(sourceRoot)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const source = await readFile(file, "utf8");
    for (const specifier of collectModuleSpecifiers(source, file)) {
      const target = resolveImportTarget(file, specifier, workspaceDirectories);
      if (target === undefined) continue;
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
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) files.push(path);
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
    !targetPath.startsWith("packages/auth/") &&
    !targetPath.startsWith("packages/operations/")
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

function readRootOption() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0) return undefined;
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--root" ||
    arguments_[1] === undefined ||
    arguments_[1] === "" ||
    arguments_[1].startsWith("--")
  ) {
    throw new Error("usage: check-boundaries.mjs [--root <workspace-root>]");
  }
  return arguments_[1];
}
