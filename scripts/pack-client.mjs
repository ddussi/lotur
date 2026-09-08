import { execFile } from "node:child_process";
import { mkdir, mkdtemp, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withClientPackage, outputDirectory } from "./client-package.mjs";

const execute = promisify(execFile);
try {
  const destination = outputDirectory(process.argv.slice(2));
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(destination, ".client-pack-"));
  try {
    await withClientPackage(async ({ directory, version }) => {
      const { stdout } = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
        cwd: directory, env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_cache: join(temporary, "npm-cache") },
      });
      const [packed] = JSON.parse(stdout);
      const filename = `review-tunnel-client-${version}.tgz`;
      if (packed.filename !== filename) throw new Error("Unexpected Client archive name.");
      const target = join(destination, filename);
      await link(join(temporary, filename), target);
      console.log(target);
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
} catch (error) {
  console.error(error.code === "EEXIST" ? "The Client archive already exists; choose an empty output directory to preserve it." : error.message);
  process.exitCode = 1;
}
