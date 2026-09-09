import { verifyImageRecord } from "./candidate-images.mjs";

// Copy only a selected immutable manifest. Never rebuild or combine candidates.
export async function releaseImageTags(record, context, { docker, publish = false }) {
  verifyImageRecord(record, context);
  const images = record.images.map(image => ({ ...image,
    versionTag: `ghcr.io/${record.repository}-${image.target}:v${record.version}`,
  }));
  async function inspect(reference, optional = false) {
    const result = await docker(["buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"], { allowFailure: true });
    if (result.code !== 0) {
      const error = result.stderr + result.stdout;
      if (optional && !/unauthorized|denied|forbidden|401|403/i.test(error) && /manifest unknown|no such manifest|: not found/i.test(error)) return undefined;
      throw new Error(`Cannot inspect registry reference: ${reference}`);
    }
    const digest = JSON.parse(result.stdout).digest;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error(`Missing manifest digest: ${reference}`);
    return digest;
  }
  async function destination(image) {
    const found = await inspect(image.versionTag, true);
    if (found !== undefined && found !== image.reference.split("@")[1]) {
      throw new Error(`Version tag already identifies different contents: ${image.versionTag}`);
    }
    return found;
  }
  // Establish all six sources and destinations before any registry write.
  for (const image of images) {
    if (await inspect(image.reference) !== image.reference.split("@")[1]) throw new Error(`Source digest mismatch: ${image.target}`);
    await docker(["pull", "--platform", record.platform, image.reference]);
    const actual = JSON.parse((await docker(["image", "inspect", image.reference])).stdout)[0];
    const labels = actual.Config?.Labels;
    if (actual.Id !== image.configDigest || `${actual.Os}/${actual.Architecture}` !== record.platform ||
        labels?.["org.opencontainers.image.revision"] !== context.revision ||
        labels?.["org.opencontainers.image.version"] !== context.version ||
        labels?.["org.opencontainers.image.source"] !== `https://github.com/${context.repository}`) {
      throw new Error(`Source image identity mismatch: ${image.target}`);
    }
    await destination(image);
  }
  for (const image of images) {
    // A retry may complete missing tags, but cannot replace a different digest.
    if (await destination(image) === undefined) {
      await docker(["buildx", "imagetools", "create", "--prefer-index=false",
        ...publish ? [] : ["--dry-run"], "--tag", image.versionTag, image.reference]);
    }
    if (publish && await inspect(image.versionTag) !== image.reference.split("@")[1]) {
      throw new Error(`Published version digest differs from the candidate: ${image.target}`);
    }
  }
  return { format: "review-tunnel-image-tags-v1", status: publish ? "published" : "dry-run",
    version: record.version, source: record.source, repository: record.repository, platform: record.platform,
    candidateTag: record.candidateTag, images: images.map(({ target, reference, versionTag, configDigest }) => ({ target, reference, versionTag, configDigest })) };
}
