import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "..",
  testMatch: [
    "frameworks/compatibility.spec.mjs",
    "review/review-overlay.spec.mjs",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: "line",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
});
