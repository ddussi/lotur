import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { checkReleaseVersions } from "./release-version.mjs";
import { RELEASE_FORMAT, RUNTIME_TARGETS, packageFiles, releaseFiles, sha256, verifyRelease } from "./release-artifacts.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const git = async args => (await execute("git", args, { cwd: root })).stdout.trim();
let destination, owned = false, temporary;
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output-dir" || !args[1] || args[1].startsWith("--"))) {
    throw new Error("Usage: npm run pack:release -- [--output-dir <new-directory>]");
  }
  const { version } = await checkReleaseVersions(root);
  if (await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Commit or preserve working-tree changes before building a release candidate.");
  const revision = await git(["rev-parse", "HEAD"]);
  const tree = await git(["rev-parse", "HEAD^{tree}"]);
  destination = resolve(args[1] ?? join(root, "dist/releases", `${version}-${revision.slice(0, 12)}`));
  await mkdir(resolve(destination, ".."), { recursive: true });
  await mkdir(destination); owned = true;
  temporary = await mkdtemp(join(tmpdir(), "review-tunnel-release-build-"));
  const environment = { ...process.env, npm_config_cache: join(temporary, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false" };
  const sourceName = `review-tunnel-${version}-source.tar.gz`;
  await execute("git", ["archive", "--format=tar.gz", `--prefix=review-tunnel-${version}/`, "--output", join(destination, sourceName), revision], { cwd: root });
  await execute(process.execPath, ["scripts/pack-client.mjs", "--output-dir", destination], { cwd: root, env: environment });
  for (const workspace of ["vite-integration", "next-integration"]) {
    await execute("npm", ["pack", `./apps/${workspace}`, "--pack-destination", destination, "--json"], { cwd: root, env: environment });
  }
  for (const name of ["LICENSE", "CHANGELOG.md"]) await cp(join(root, name), join(destination, name));
  if (await git(["rev-parse", "HEAD"]) !== revision || await git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Source changed while building; the incomplete candidate was discarded.");
  }
  const assets = [];
  for (const file of releaseFiles(version).sort()) {
    const bytes = await readFile(join(destination, file));
    assets.push({ file, sha256: sha256(bytes), bytes: bytes.length });
  }
  const manifest = {
    format: RELEASE_FORMAT, version, tag: `v${version}`,
    source: { revision, tree, committedAt: await git(["show", "-s", "--format=%cI", revision]) },
    minimumNodeMajor: 24, packages: packageFiles(version), assets,
    runtimeImages: { targets: RUNTIME_TARGETS, publication: "separate", plannedPlatform: "linux/amd64" },
  };
  await writeFile(join(destination, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = [...assets.map(asset => `${asset.sha256}  ${asset.file}`), `${sha256(await readFile(join(destination, "release-manifest.json")))}  release-manifest.json`].sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  await writeFile(join(destination, "SHA256SUMS"), `${sums.join("\n")}\n`);
  await verifyRelease(destination, revision);
  console.log(`Release candidate ${version} from ${revision}\n${destination}\nVerified ${sums.length} file checksums. Nothing was published.`);
  owned = false;
} catch (error) {
  console.error(error.code === "EEXIST" ? "Release output already exists. Choose a new directory; existing artifacts were preserved." : error.message);
  process.exitCode = 1;
} finally {
  if (owned) await rm(destination, { recursive: true, force: true });
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
