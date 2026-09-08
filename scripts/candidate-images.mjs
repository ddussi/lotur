import { RUNTIME_TARGETS } from "./release-artifacts.mjs";
import { VERSION_PATTERN } from "./release-version.mjs";

export const IMAGE_FORMAT = "review-tunnel-images-v1";
export const IMAGE_PLATFORM = "linux/amd64";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const failures = {
  gateway: ["METRICS_BEARER_TOKEN must contain at least 32", ["-e", "METRICS_BEARER_TOKEN=short"]],
  "admin-cli": ["DATABASE_URL is required", []],
  client: ["Usage:", []],
  "canary-check": ["CANARY_CONTENT_URL is required", []],
  "db-backup": ["DATABASE_URL is required", []],
  "db-restore": ["usage: postgres-restore", []],
};

function checkPackage(info, target, { repository, visibility }) {
  const [owner, name] = repository.split("/");
  if (info.visibility !== visibility || info.owner?.login?.toLowerCase() !== owner || info.name !== `${name}-${target}` ||
      (info.repository?.full_name !== undefined && info.repository.full_name.toLowerCase() !== repository)) {
    throw new Error(`Package ${target} must have ${visibility} visibility and the selected owner/name in ${repository}.`);
  }
}

export function candidateContext(environment, event, version) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      ![true, "true"].includes(event.inputs?.candidate_images)) {
    throw new Error("Image publication requires an explicit candidate_images manual workflow run.");
  }
  const repository = environment.GITHUB_REPOSITORY?.toLowerCase();
  const revision = environment.GITHUB_SHA;
  const runId = environment.GITHUB_RUN_ID;
  const attempt = environment.GITHUB_RUN_ATTEMPT;
  const visibility = event.inputs.candidate_visibility ?? "private";
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(repository ?? "") ||
      !/^[a-f0-9]{40}$/.test(revision ?? "") || !/^[1-9][0-9]*$/.test(runId ?? "") ||
      !/^[1-9][0-9]*$/.test(attempt ?? "") || !VERSION_PATTERN.test(version) ||
      !["private", "public"].includes(visibility)) throw new Error("Invalid image candidate context.");
  return { repository, revision, version, visibility, runId, attempt,
    tag: `candidate-${revision}-${runId}-${attempt}` };
}

export function verifyImageRecord(record, { revision, version, repository }) {
  if (record.format !== IMAGE_FORMAT || record.source?.revision !== revision || record.version !== version ||
      record.repository !== repository || record.platform !== IMAGE_PLATFORM ||
      JSON.stringify(record.images?.map(image => image.target)) !== JSON.stringify(RUNTIME_TARGETS)) {
    throw new Error("Image record source, version, platform or target inventory does not match.");
  }
  if (!/^candidate-[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$/.test(record.candidateTag ?? "") ||
      !record.candidateTag.startsWith(`candidate-${revision}-`)) throw new Error("Invalid image candidate tag.");
  for (const image of record.images) {
    const prefix = `ghcr.io/${repository}-${image.target}`;
    if (image.tag !== `${prefix}:${record.candidateTag}` || !image.reference?.startsWith(`${prefix}@`) ||
        !digestPattern.test(image.reference.slice(prefix.length + 1)) || !digestPattern.test(image.configDigest ?? "") ||
        !["private", "public"].includes(image.visibility)) throw new Error(`Invalid immutable image identity: ${image.target}`);
  }
  return record;
}

// All registry operations use the selected repository. A missing package may be
// created with GHCR's private default; access errors must not mean "missing".
export async function publishCandidateImages(context, { packageInfo, docker, log = () => {} }) {
  const { repository, revision, version, tag, visibility } = context;
  const existingPackages = new Set();
  for (const target of RUNTIME_TARGETS) {
    const info = await packageInfo(target);
    if (info) checkPackage(info, target, context);
    if (!info && visibility !== "private") throw new Error(`Create and review the private ${target} package before public candidate publication.`);
    if (info) existingPackages.add(target);
  }
  // GHCR's REST package representation can omit `repository` even for a
  // linked package. Check the selected package's actual previous image source.
  for (const target of existingPackages) {
    const info = await packageInfo(target);
    checkPackage(info, target, context);
    if (!digestPattern.test(info.latestDigest ?? "")) throw new Error(`Cannot identify an existing ${target} source image.`);
    const previous = `ghcr.io/${repository}-${target}@${info.latestDigest}`;
    await docker(["pull", "--platform", IMAGE_PLATFORM, previous]);
    const inspected = JSON.parse((await docker(["image", "inspect", previous])).stdout)[0];
    if (inspected.Config?.Labels?.["org.opencontainers.image.source"] !== `https://github.com/${repository}`) {
      throw new Error(`Existing ${target} image belongs to a different or unidentified source repository.`);
    }
  }
  const images = [];
  for (const target of RUNTIME_TARGETS) {
    const image = `ghcr.io/${repository}-${target}:${tag}`;
    if (existingPackages.has(target)) {
      const existing = await docker(["manifest", "inspect", image], { allowFailure: true });
      if (existing.code === 0) throw new Error(`Candidate tag already exists; refusing to replace ${target}.`);
      if (!/manifest unknown|no such manifest|not found/i.test(existing.stderr + existing.stdout)) {
        throw new Error(`Cannot establish that the ${target} candidate tag is unused.`);
      }
    }
    log(`Building and checking ${target} (${IMAGE_PLATFORM}).`);
    await docker(["build", "--platform", IMAGE_PLATFORM, "--target", target,
      "--label", `org.opencontainers.image.source=https://github.com/${repository}`,
      "--label", `org.opencontainers.image.revision=${revision}`,
      "--label", `org.opencontainers.image.version=${version}`,
      "--label", "org.opencontainers.image.licenses=MIT", "-t", image, "."]);
    await smoke(target, image, version, docker);
    await docker(["push", image]);
    const local = JSON.parse((await docker(["image", "inspect", image])).stdout)[0];
    const prefix = `ghcr.io/${repository}-${target}@`;
    const reference = local.RepoDigests?.find(value => value.startsWith(prefix) && digestPattern.test(value.slice(prefix.length)));
    if (!reference) throw new Error(`Registry digest missing for ${target}.`);
    await docker(["pull", "--platform", IMAGE_PLATFORM, reference]);
    const pulled = JSON.parse((await docker(["image", "inspect", reference])).stdout)[0];
    const labels = pulled.Config?.Labels;
    if (`${pulled.Os}/${pulled.Architecture}` !== IMAGE_PLATFORM || pulled.Id !== local.Id ||
        labels?.["org.opencontainers.image.revision"] !== revision || labels?.["org.opencontainers.image.version"] !== version ||
        labels?.["org.opencontainers.image.source"] !== `https://github.com/${repository}` || labels?.["org.opencontainers.image.licenses"] !== "MIT") {
      throw new Error(`Pulled ${target} image differs from the checked source/platform.`);
    }
    await smoke(target, reference, version, docker);
    const info = await packageInfo(target);
    if (!info) throw new Error(`Published ${target} package metadata is unavailable.`);
    checkPackage(info, target, context);
    images.push({ target, tag: image, reference, configDigest: pulled.Id, visibility: info.visibility });
  }
  return verifyImageRecord({ format: IMAGE_FORMAT, version, source: { revision }, repository,
    platform: IMAGE_PLATFORM, candidateTag: tag,
    workflow: `https://github.com/${repository}/actions/runs/${context.runId}/attempts/${context.attempt}`, images }, context);
}

async function smoke(target, image, version, docker) {
  const [message, options] = failures[target];
  const result = await docker(["run", "--rm", "--network", "none", ...options, image], { allowFailure: true });
  if (result.code === 0 || !(result.stdout + result.stderr).includes(message)) throw new Error(`Unexpected fail-closed smoke result: ${target}`);
  if (target === "client" && (await docker(["run", "--rm", "--network", "none", image, "--version"])).stdout.trim() !== version) {
    throw new Error("Client image version does not match the release.");
  }
}
