import { verifyRelease } from "./release-artifacts.mjs";

try {
  const [directory, flag, revision, ...extra] = process.argv.slice(2);
  if (!directory || directory.startsWith("--") || extra.length ||
    (flag !== undefined && (flag !== "--commit" || !/^[a-f0-9]{40}$/.test(revision ?? "")))) {
    throw new Error("Usage: npm run verify:release -- <directory> [--commit <40-character-sha>]");
  }
  const manifest = await verifyRelease(directory, revision);
  console.log(`Release ${manifest.version}: all checksums and source ${manifest.source.revision} verified.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
