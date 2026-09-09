import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkReleaseVersions } from "./release-version.mjs";
import { sha256 } from "./release-artifacts.mjs";
import { releaseImageTags } from "./release-image-tags.mjs";

let authDirectory;
function run(command, args, { env = process.env, input, allowFailure = false } = {}) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { env, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (!allowFailure || typeof error.code !== "number")) reject(new Error(`${command} ${args[0]} failed: ${stderr.slice(-3000)}`));
      else accept({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
try {
  const [mode, path] = process.argv.slice(2);
  if (process.argv.length !== 4 || !["--dry-run", "--publish"].includes(mode) || !path ||
      process.env.GITHUB_ACTIONS !== "true" || !process.env.GH_TOKEN) {
    throw new Error("Usage in CI with its repository token: promote-release-images.mjs --dry-run|--publish <images.json>");
  }
  if (mode === "--publish" && (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_WORKFLOW !== "Release image tags")) {
    throw new Error("Final tags require the explicit Release image tags workflow.");
  }
  const revision = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
  if (revision !== process.env.GITHUB_SHA || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(repository ?? "") ||
      (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim()) {
    throw new Error("Promotion requires the clean, exact workflow source.");
  }
  const directory = dirname(resolve(path));
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(["SHA256SUMS", "images.json"])) throw new Error("Unexpected image record files.");
  for (const name of ["images.json", "SHA256SUMS"]) {
    if (!(await lstat(join(directory, name))).isFile()) throw new Error("Image record files must be regular files.");
  }
  const bytes = await readFile(join(directory, "images.json"));
  if (await readFile(join(directory, "SHA256SUMS"), "utf8") !== `${sha256(bytes)}  images.json\n`) throw new Error("Image record checksum mismatch.");
  const { version } = await checkReleaseVersions(process.cwd());
  authDirectory = await mkdtemp(join(tmpdir(), "review-tunnel-promotion-auth-"));
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.DOCKER_CONFIG = authDirectory;
  await run("docker", ["login", "ghcr.io", "--username", process.env.GITHUB_ACTOR, "--password-stdin"], { env, input: process.env.GH_TOKEN });
  const result = await releaseImageTags(JSON.parse(bytes), { revision, repository, version }, {
    publish: mode === "--publish", docker: (args, options) => run("docker", args, { ...options, env }),
  });
  // Outside the two-file candidate directory, which remains unchanged.
  await writeFile("dist/release-image-tags.json", `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(`${result.status}: six exact candidate images mapped to v${version}. No repository visibility or deployment setting changed.`);
} catch (error) {
  console.error(String(error.message).split(process.env.GH_TOKEN || "\0").join("[redacted]"));
  process.exitCode = 1;
} finally {
  if (authDirectory) await rm(authDirectory, { recursive: true, force: true });
}
