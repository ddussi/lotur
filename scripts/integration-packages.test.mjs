import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repositoryRoot = new URL("..", import.meta.url);

test("published Vite and Next integrations install and import outside the monorepo", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "review-tunnel-packages-"));
  const packageDirectory = join(temporaryRoot, "tarballs");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const npmCache = join(temporaryRoot, "npm-cache");
  try {
    await Promise.all([
      mkdir(packageDirectory),
      mkdir(consumerDirectory),
    ]);
    const environment = {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    for (const packagePath of ["./apps/vite-integration", "./apps/next-integration"]) {
      execFileSync("npm", ["pack", packagePath, "--pack-destination", packageDirectory], {
        cwd: repositoryRoot,
        env: environment,
        stdio: "pipe",
      });
    }
    const tarballs = (await readdir(packageDirectory))
      .filter((file) => file.endsWith(".tgz"))
      .map((file) => join(packageDirectory, file));
    assert.equal(tarballs.length, 2);
    await writeFile(
      join(consumerDirectory, "package.json"),
      JSON.stringify({ name: "external-review-tunnel-consumer", private: true, type: "module" }),
    );
    execFileSync("npm", [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--offline",
      ...tarballs,
    ], {
      cwd: consumerDirectory,
      env: environment,
      stdio: "pipe",
    });

    await writeFile(join(consumerDirectory, "smoke.mjs"), `
      import { reviewTunnel } from "@review-tunnel/vite";
      import { reviewTunnelScriptProps, withReviewTunnel } from "@review-tunnel/next";
      if (reviewTunnel().name !== "review-tunnel") throw new Error("Vite import failed");
      if (reviewTunnelScriptProps(false) !== undefined) throw new Error("production script enabled");
      const config = withReviewTunnel(
        { reactStrictMode: true },
        { allowedDevOrigins: [], enabled: false },
      );
      if (config.reactStrictMode !== true) throw new Error("Next import failed");
    `);
    execFileSync(process.execPath, ["smoke.mjs"], {
      cwd: consumerDirectory,
      env: environment,
      stdio: "pipe",
    });
    for (const packageName of ["vite", "next"]) {
      const installedRoot = join(
        consumerDirectory,
        "node_modules",
        "@review-tunnel",
        packageName,
      );
      const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
      assert.equal(manifest.license, "MIT");
      assert.equal(
        await readFile(join(installedRoot, "LICENSE"), "utf8"),
        await readFile(new URL("../LICENSE", import.meta.url), "utf8"),
      );
      assert.equal(manifest.dependencies, undefined);
      assert.equal(manifest.exports["."].import, "./dist/index.js");
      assert.match(await readFile(join(installedRoot, "dist", "index.d.ts"), "utf8"), /export/);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
