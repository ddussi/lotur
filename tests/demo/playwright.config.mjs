import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["demo.spec.mjs", "client-package.spec.mjs"], fullyParallel: false, workers: 1,
  timeout: 180_000, expect: { timeout: 20_000 }, reporter: "line",
  use: { browserName: "chromium", channel: "chrome", headless: true, viewport: { width: 1440, height: 1100 }, trace: "retain-on-failure" },
});
