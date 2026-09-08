import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseVersions } from "./release-version.mjs";
import { candidateContext, publishCandidateImages } from "./candidate-images.mjs";
import { sha256 } from "./release-artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let temporary;
function run(command, args, { env = process.env, input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (error, stdout, stderr) => {
      if (error && !allowFailure) reject(new Error(`${command} ${args[0]} failed: ${stderr.slice(-6000)}`));
      else if (error && typeof error.code !== "number") reject(new Error(`${command} could not finish (${error.code}).`));
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
try {
  if (process.argv.length !== 2 || !process.env.GITHUB_EVENT_PATH || !process.env.GH_TOKEN) throw new Error("Run the manual CI candidate_images job with its repository token.");
  const { version } = await checkReleaseVersions(root);
  const context = candidateContext(process.env, JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")), version);
  if ((await run("git", ["rev-parse", "HEAD"])).stdout.trim() !== context.revision ||
      (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim()) throw new Error("Image source must be the clean workflow commit.");
  const metadata = JSON.parse((await run("gh", ["api", `repos/${context.repository}`])).stdout);
  if (metadata.full_name?.toLowerCase() !== context.repository) throw new Error("Repository identity differs from the candidate context.");
  const [owner, name] = context.repository.split("/");
  const kind = metadata.owner.type === "Organization" ? "orgs" : "users";
  const packageInfo = async target => {
    const result = await run("gh", ["api", `${kind}/${owner}/packages/container/${name}-${target}`], { allowFailure: true });
    if (result.code === 0) return JSON.parse(result.stdout);
    if (/\(HTTP 404\)/.test(result.stderr)) return undefined;
    throw new Error(`Cannot inspect ${target} package settings; verify the workflow's package access.`);
  };
  temporary = await mkdtemp(join(tmpdir(), "review-tunnel-image-auth-"));
  const dockerEnvironment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  dockerEnvironment.DOCKER_CONFIG = temporary;
  const docker = (args, options) => run("docker", args, { ...options, env: dockerEnvironment });
  await run("docker", ["login", "ghcr.io", "--username", process.env.GITHUB_ACTOR, "--password-stdin"], { env: dockerEnvironment, input: process.env.GH_TOKEN });
  const record = await publishCandidateImages(context, { packageInfo, docker, log: console.log });
  if ((await run("git", ["rev-parse", "HEAD"])).stdout.trim() !== context.revision ||
      (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim()) throw new Error("Source changed during the image build; no complete candidate record was written.");
  const parent = join(root, "dist/image-candidates");
  await mkdir(parent, { recursive: true });
  const output = join(parent, record.candidateTag);
  await mkdir(output);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(join(output, "images.json"), bytes);
  await writeFile(join(output, "SHA256SUMS"), `${sha256(bytes)}  images.json\n`);
  console.log(`Verified all six ${context.visibility} candidate images from ${context.revision}. No release tag or deployment was created.`);
} catch (error) {
  const message = String(error.message).split(process.env.GH_TOKEN || "\0").join("[redacted]");
  console.error(message);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
