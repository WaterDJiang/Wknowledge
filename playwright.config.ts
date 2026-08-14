import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/tests",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry"
  },
  webServer: {
    command: "pnpm --filter @wknowledge/web dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
