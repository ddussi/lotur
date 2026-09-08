import { fileURLToPath } from "node:url";
import { checkReleaseVersions } from "./release-version.mjs";

try {
  const result = await checkReleaseVersions(fileURLToPath(new URL("..", import.meta.url)));
  console.log(`Release version ${result.version}: ${result.packages.length} packages and Docker runtime agree.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
