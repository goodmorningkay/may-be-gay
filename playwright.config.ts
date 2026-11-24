import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    baseURL: "https://app.may-be.localhost",
    // Only this disposable internal CA; this suite does not verify OS trust.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    reducedMotion: "reduce",
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testMatch: "core.spec.ts" },
    { name: "firefox", use: { browserName: "firefox" }, testMatch: "core.spec.ts" },
    { name: "webkit", use: { browserName: "webkit" }, testMatch: "core.spec.ts" },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }, testMatch: "core.spec.ts" },
    { name: "lifecycle", use: { browserName: "chromium" }, testMatch: ["lifecycle.spec.ts", "product-review.spec.ts", "media-review.spec.ts", "profile-embeds.spec.ts"] },
  ],
});
