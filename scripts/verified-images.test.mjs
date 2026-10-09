import assert from 'node:assert/strict';
import test from 'node:test';
import { RUNTIME_TARGETS } from './release-artifacts.mjs';
import { verifyManifest, inspectVerifiedImages, publishVerifiedImage } from './verified-images.mjs';
const context = { repository: 'example/project', revision: 'a'.repeat(40), version: '0.1.0-alpha.1', runId: '123', attempt: '1' };
const id = `sha256:${'b'.repeat(64)}`;
const manifest = { format: 'review-tunnel-verified-images-v1', ...context, platform: 'linux/amd64', images: RUNTIME_TARGETS.map(target => ({ target, reference: `review-tunnel-${target}:ci`, id })) };
const inspected = { Id: id, Os: 'linux', Architecture: 'amd64', Config: { Labels: Object.fromEntries(Object.entries({ source: 'https://github.com/example/project', revision: context.revision, version: context.version, licenses: 'MIT' }).map(([key,value]) => [`org.opencontainers.image.${key}`, value])) } };
test('manifest requires all six images and the exact workflow attempt', () => {
  assert.equal(verifyManifest(manifest, context), manifest);
  for (const change of [{ images: manifest.images.slice(1) }, { attempt: '2' }, { revision: 'c'.repeat(40) }, { images: manifest.images.map(image => ({ ...image, id: 'invalid' })) }]) assert.throws(() => verifyManifest({ ...manifest, ...change }, context));
});
test('loaded identities must match before any publication', async () => {
  const docker = async () => ({ stdout: JSON.stringify([{ ...inspected, Id: `sha256:${'c'.repeat(64)}` }]) });
  await assert.rejects(inspectVerifiedImages(manifest, context, docker), /verified image/);
});
test('registry digest must resolve to the image verified earlier, never rebuilt', async () => {
  const calls = [];
  const reference = `ghcr.io/example/project-gateway@sha256:${'d'.repeat(64)}`;
  const docker = async args => { calls.push(args); return { stdout: JSON.stringify([{ ...inspected, RepoDigests: [reference] }]) }; };
  assert.equal(await publishVerifiedImage(manifest.images[0], 'ghcr.io/example/project-gateway:candidate', context, docker), reference);
  assert.deepEqual(calls.map(args => args[0]), ['image', 'tag', 'push', 'image', 'pull', 'image']);
  assert.equal(calls[1][1], id);
  await assert.rejects(publishVerifiedImage(manifest.images[0], 'ghcr.io/example/project-gateway:candidate', context, async args => ({ stdout: JSON.stringify([{ ...inspected, Id: args[2]?.includes('@') ? `sha256:${'e'.repeat(64)}` : id, RepoDigests: [reference] }]) })), /verified image/);
});
test('source, release version, license and platform are checked on every loaded target', async () => {
  for (const changed of [
    { Architecture: 'arm64' },
    ...['source', 'revision', 'version', 'licenses'].map(key => ({ Config: { Labels: { ...inspected.Config.Labels, [`org.opencontainers.image.${key}`]: 'wrong' } } })),
  ]) {
    await assert.rejects(inspectVerifiedImages(manifest, context, async () => ({ stdout: JSON.stringify([{ ...inspected, ...changed }]) })), /verified image/);
  }
});
