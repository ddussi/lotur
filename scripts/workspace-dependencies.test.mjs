import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectModuleSpecifiers,
  resolveImportTarget,
} from "./check-boundaries-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_SCRIPT_NAMES = [
  "backup:postgres",
  "canary:origin",
  "restore:postgres",
  "verify:public-path",
];

test("root 운영 entrypoint의 직접 runtime dependency를 root가 선언한다", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  for (const scriptName of ROOT_RUNTIME_SCRIPT_NAMES) {
    const command = manifest.scripts?.[scriptName];
    assert.equal(typeof command, "string", `missing root script: ${scriptName}`);
    const match = /^node\s+([^\s]+)(?:\s|$)/.exec(command);
    assert.notEqual(match, null, `${scriptName} must be a direct Node entrypoint`);
    const entrypoint = resolve(root, match[1]);
    const source = await readFile(entrypoint, "utf8");

    for (const specifier of collectModuleSpecifiers(source, entrypoint)) {
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
      const dependency = packageName(specifier);
      assert.ok(
        manifest.dependencies?.[dependency] !== undefined,
        `${scriptName} must declare ${dependency} in root dependencies`,
      );
    }
  }
});

test("각 workspace는 production source가 사용하는 dependency를 직접 선언한다", async () => {
  const workspaces = await loadWorkspaces();
  const workspaceDirectories = new Map(
    workspaces.map((workspace) => [workspace.name, workspace.directory]),
  );

  for (const workspace of workspaces) {
    const required = new Set();
    for (const file of await listSourceFiles(join(workspace.directory, "src"))) {
      const source = await readFile(file, "utf8");
      for (const specifier of collectModuleSpecifiers(source, file)) {
        if (specifier.startsWith("node:")) continue;
        const target = resolveImportTarget(
          file,
          specifier,
          workspaceDirectories,
        );
        if (target !== undefined) {
          const owner = workspaces.find((candidate) => isWithin(target, candidate.directory));
          if (owner !== undefined && owner.name !== workspace.name) required.add(owner.name);
          continue;
        }
        required.add(packageName(specifier));
      }
    }

    for (const dependency of required) {
      assert.ok(
        workspace.dependencies[dependency] !== undefined,
        `${workspace.name} must declare ${dependency} in dependencies`,
      );
    }
  }
});

async function loadWorkspaces() {
  const workspaces = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, group, entry.name);
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      workspaces.push({
        directory,
        name: manifest.name,
        dependencies: manifest.dependencies ?? {},
      });
    }
  }
  return workspaces;
}

async function listSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listSourceFiles(path));
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.")
    ) files.push(path);
  }
  return files;
}

function isWithin(path, directory) {
  const pathFromDirectory = relative(directory, path);
  return pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !pathFromDirectory.startsWith(sep);
}

function packageName(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}
