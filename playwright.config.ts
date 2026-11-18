import { defineConfig } from "@playwright/test";

const PORT = 8799;

// Browser suite for /demo and /app. Run with `npm run e2e` (see README, "Browser tests"). Not part of `npm test`.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // /app specs share one local D1 (one password row)
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 360, height: 740 }, hasTouch: true } },
  ],
  webServer: {
    // LOGIN_DELAY_MS=0 removes the deliberate slow-down after a wrong password.
    command: `npx wrangler dev --port ${PORT} --infer-origin-from-routes=false --var LOGIN_DELAY_MS:0`,
    url: `http://localhost:${PORT}/demo`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
