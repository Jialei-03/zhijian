import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
process.env.E2E_TEST_PASSWORD ||= randomBytes(30).toString("base64url");
// Parallel checkouts each run their own server: E2E_PORT keeps them apart.
const port = process.env.E2E_PORT || "8766";
export default defineConfig({
  testDir: "./e2e",
  // Files run side by side, each worker on its own accounts (see who() in
  // e2e/reader/fixtures.ts); the tests of one file run in order.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 4,
  // The slowest passing test takes under 20 s: a failure is reported, not waited out.
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    [
      "html",
      { open: "never", outputFolder: "../test-results/playwright-report" },
    ],
    ["json", { outputFile: "../test-results/browser-results.json" }],
  ],
  outputDir: "../test-results/browser",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    // The sign-in page and the interface follow the browser language; the specs are written in Chinese.
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // README shots use a real, separately seeded backend.local service.
  webServer:
    process.env.README_SHOTS === "1"
      ? undefined
      : {
          command: "../.venv/bin/python ../scripts/e2e_server.py",
          url: `http://127.0.0.1:${port}/api/v1/health`,
          timeout: 30000,
          reuseExistingServer: false,
        },
});
