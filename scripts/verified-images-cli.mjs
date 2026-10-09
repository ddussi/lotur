import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseVersions } from './release-version.mjs';
import { RUNTIME_TARGETS } from './release-artifacts.mjs';
import { inspectVerifiedImages, verifyManifest, publishVerifiedImage, VERIFIED_PLATFORM } from './verified-images.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = process.env.VERIFIED_IMAGES_DIRECTORY || 'dist/verified-images';
export function docker(args) {
  return new Promise((resolve, reject) => execFile('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60 * 1000 }, (error, stdout, stderr) => error ? reject(new Error(`docker ${args[0]} failed: ${stderr.slice(-6000)}`)) : resolve({ stdout, stderr })));
}
export async function loadVerifiedImages(context, runDocker = docker) {
  const manifest = verifyManifest(JSON.parse(await readFile(join(directory, 'verified-images.json'), 'utf8')), context);
  await runDocker(['load', '--input', join(directory, 'images.tar')]);
  await inspectVerifiedImages(manifest, context, runDocker);
  return manifest;
}
async function main() {
  const { version } = await checkReleaseVersions(root);
  const context = { version, repository: process.env.GITHUB_REPOSITORY?.toLowerCase(), revision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(context.repository ?? '') ||
      !/^[a-f0-9]{40}$/.test(context.revision ?? '') || !/^[1-9][0-9]*$/.test(context.runId ?? '') || !/^[1-9][0-9]*$/.test(context.attempt ?? '')) throw new Error('Invalid verification workflow context.');
  const command = process.argv[2];
  if (command === 'build') {
    await mkdir(directory, { recursive: true });
    const images = [];
    for (const target of RUNTIME_TARGETS) {
      const reference = `review-tunnel-${target}:ci`;
      await docker(['build', '--platform', VERIFIED_PLATFORM, '--target', target,
        '--label', `org.opencontainers.image.source=https://github.com/${context.repository}`,
        '--label', `org.opencontainers.image.revision=${context.revision}`, '--label', `org.opencontainers.image.version=${version}`,
        '--label', 'org.opencontainers.image.licenses=MIT', '-t', reference, '.']);
      images.push({ target, reference, id: JSON.parse((await docker(['image', 'inspect', reference])).stdout)[0].Id });
    }
    const manifest = { format: 'review-tunnel-verified-images-v1', ...context, platform: VERIFIED_PLATFORM, images };
    await inspectVerifiedImages(manifest, context, docker);
    await writeFile(join(directory, 'verified-images.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (command === 'seal') {
    const manifest = JSON.parse(await readFile(join(directory, 'verified-images.json'), 'utf8'));
    await inspectVerifiedImages(manifest, context, docker);
    await docker(['save', '--output', join(directory, 'images.tar'), ...manifest.images.map(image => image.reference)]);
  } else if (command === 'publish') {
    const manifest = await loadVerifiedImages(context);
    const images = [];
    for (const target of ['gateway', 'admin-cli', 'canary-check']) {
      const expected = manifest.images.find(image => image.target === target);
      const reference = await publishVerifiedImage(expected, `ghcr.io/${context.repository}-${target}:${context.revision}`, context, docker);
      images.push({ target, reference, verifiedImageId: expected.id });
      await appendFile(process.env.GITHUB_OUTPUT, `${target}=${reference}\n`);
    }
    await writeFile(join(directory, 'published-images.json'), `${JSON.stringify({ ...manifest, format: 'review-tunnel-published-images-v1', images }, null, 2)}\n`);
  } else throw new Error('Usage: verified-images-cli.mjs build|seal|publish');
}
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
