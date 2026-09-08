import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["restore.spec.mjs"], workers: 1, fullyParallel: false,
  outputDir: "../../test-results/restore",
  timeout: 240_000, expect: { timeout: 20_000 }, reporter: "line",
  use: { browserName: "chromium", channel: "chrome", headless: true, trace: "retain-on-failure" },
});
