import { builtinModules } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

export async function withClientPackage(consume) {
  const temporary = await mkdtemp(join(tmpdir(), "review-tunnel-client-package-"));
  const directory = join(temporary, "package");
  try {
    await mkdir(directory);
    const source = await readJson(join(root, "apps/client/package.json"));
    const rootManifest = await readJson(join(root, "package.json"));
    const lock = await readJson(join(root, "package-lock.json"));
    const wsManifest = await readJson(join(root, "node_modules/ws/package.json"));
    if (source.version !== rootManifest.version) throw new Error("Client and root versions must match before packaging.");
    if (wsManifest.version !== lock.packages["node_modules/ws"].version) throw new Error("Installed ws differs from the lockfile; run npm ci.");
    const result = await build({
      root, configFile: false, logLevel: "silent", publicDir: false,
      ssr: { target: "node", external: ["ws"] },
      build: {
        ssr: join(root, "apps/client/src/main.ts"), target: "node24", write: false,
        minify: false, sourcemap: false,
        rolldownOptions: { external: id => builtins.has(id) || id === "ws",
          output: { format: "es", entryFileNames: "client.mjs" } },
      },
    });
    const output = Array.isArray(result) ? result[0].output : result.output;
    if (output.length !== 1 || output[0].type !== "chunk") throw new Error("Client must build to one self-contained application module.");
    const bundle = output[0];
    for (const id of [...bundle.imports, ...bundle.dynamicImports]) {
      if (!builtins.has(id) && id !== "ws") throw new Error(`Unexpected external Client dependency: ${id}`);
    }
    for (const id of Object.keys(bundle.modules)) {
      const path = relative(root, id).replaceAll("\\", "/");
      if (!/^(apps\/client\/|packages\/(cli-utils|protocol|proxy|relay|review)\/)/.test(path)) {
        throw new Error(`Unexpected module in Client package: ${path}`);
      }
    }
    await mkdir(join(directory, "dist")); await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "dist/client.mjs"), bundle.code);
    await writeFile(join(directory, "bin/review-tunnel.mjs"), "#!/usr/bin/env node\nawait import('../dist/client.mjs');\n", { mode: 0o755 });
    await writeFile(join(directory, "package.json"), `${JSON.stringify({
      name: source.name, version: source.version, private: true,
      description: "Authenticated sharing of a local web app through your Review Tunnel Gateway",
      type: "module", bin: { "review-tunnel": "./bin/review-tunnel.mjs" },
      files: ["bin", "dist", "THIRD_PARTY_NOTICES.md"], engines: { node: ">=24" },
      license: "MIT", repository: { type: "git", url: "git+https://github.com/ddussi/lotur.git" },
      dependencies: { ws: wsManifest.version }, bundledDependencies: ["ws"],
    }, null, 2)}\n`);
    await cp(join(root, "LICENSE"), join(directory, "LICENSE"));
    await cp(join(root, "apps/client/README.distribution.md"), join(directory, "README.md"));
    const wsLicense = await readFile(join(root, "node_modules/ws/LICENSE"), "utf8");
    await writeFile(join(directory, "THIRD_PARTY_NOTICES.md"), `# Third-party notices\n\nThe included ws ${wsManifest.version} package is distributed under the MIT license below. Its unmodified source and LICENSE are included under node_modules/ws. No optional native add-ons are included.\n\n## ws ${wsManifest.version}\n\n${wsLicense}`);
    const wsDirectory = join(directory, "node_modules/ws");
    await mkdir(wsDirectory, { recursive: true });
    // Copy only published runtime files and notices. No workspace links or native add-ons.
    for (const name of ["package.json", "LICENSE", "README.md", "browser.js", "index.js", "wrapper.mjs"]) {
      await cp(join(root, "node_modules/ws", name), join(wsDirectory, name));
    }
    await mkdir(join(wsDirectory, "lib"));
    for (const entry of await readdir(join(root, "node_modules/ws/lib"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) throw new Error("Unexpected ws runtime file; inspect its packaging before release.");
      await cp(join(root, "node_modules/ws/lib", entry.name), join(wsDirectory, "lib", entry.name));
    }
    return await consume({ directory, version: source.version, modules: Object.keys(bundle.modules).map(id => relative(root, id)) });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function outputDirectory(arguments_) {
  if (arguments_.length === 0) return resolve(root, "dist/releases");
  if (arguments_.length !== 2 || arguments_[0] !== "--output-dir" || !arguments_[1] || arguments_[1].startsWith("--")) {
    throw new Error("Usage: npm run pack:client -- [--output-dir <directory>]");
  }
  return resolve(arguments_[1]);
}
