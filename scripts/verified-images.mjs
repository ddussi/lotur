import { RUNTIME_TARGETS } from './release-artifacts.mjs';
export const VERIFIED_PLATFORM = 'linux/amd64';
const digest = /^sha256:[a-f0-9]{64}$/;
export function verifyManifest(manifest, context) {
  if (manifest.format !== 'review-tunnel-verified-images-v1' || manifest.platform !== VERIFIED_PLATFORM ||
      ['repository', 'revision', 'version', 'runId', 'attempt'].some(key => manifest[key] !== context[key]) ||
      JSON.stringify(manifest.images?.map(image => image.target)) !== JSON.stringify(RUNTIME_TARGETS) ||
      manifest.images.some(image => image.reference !== `review-tunnel-${image.target}:ci` || !digest.test(image.id))) {
    throw new Error('Invalid verified image inventory or workflow identity.');
  }
  return manifest;
}
export function verifyImage(image, expected, context) {
  const labels = image.Config?.Labels;
  if (image.Id !== expected.id || !digest.test(image.Id) || `${image.Os}/${image.Architecture}` !== VERIFIED_PLATFORM ||
      labels?.['org.opencontainers.image.source'] !== `https://github.com/${context.repository}` ||
      labels?.['org.opencontainers.image.revision'] !== context.revision ||
      labels?.['org.opencontainers.image.version'] !== context.version || labels?.['org.opencontainers.image.licenses'] !== 'MIT') {
    throw new Error(`Image differs from verified image: ${expected.target}`);
  }
}
export async function inspectVerifiedImages(manifest, context, docker) {
  verifyManifest(manifest, context);
  for (const expected of manifest.images) {
    const image = JSON.parse((await docker(['image', 'inspect', expected.reference])).stdout)[0];
    verifyImage(image, expected, context);
  }
}
export async function publishVerifiedImage(expected, tag, context, docker) {
  verifyImage(JSON.parse((await docker(['image', 'inspect', expected.id])).stdout)[0], expected, context);
  await docker(['tag', expected.id, tag]);
  await docker(['push', tag]);
  const local = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0];
  verifyImage(local, expected, context);
  const prefix = `${tag.slice(0, tag.lastIndexOf(':'))}@`;
  const reference = local.RepoDigests?.find(value => value.startsWith(prefix) && digest.test(value.slice(prefix.length)));
  if (!reference) throw new Error(`Registry digest missing for ${expected.target}.`);
  await docker(['pull', '--platform', VERIFIED_PLATFORM, reference]);
  verifyImage(JSON.parse((await docker(['image', 'inspect', reference])).stdout)[0], expected, context);
  return reference;
}
