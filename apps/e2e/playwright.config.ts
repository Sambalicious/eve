import { defineConfig, devices } from "@playwright/test"

import { resolveWebPort } from "./support/web-port.ts"

/**
 * Real-stack E2E (qa.md tier 3): Vite dev server for apps/web, the built api
 * from apps/api/dist, and an isolated Postgres in Docker. No MSW in the browser,
 * no route interception, no canned first-party responses. The only doubles are
 * declared in support/outbound-stub.mjs (ATS public APIs, all other outbound
 * calls blocked) and the synthetic session in support/db.ts (Google OAuth is not
 * exercised).
 *
 * `pnpm --filter @eve/e2e e2e` starts everything in global setup. To point the
 * tests at a stack you started yourself, set E2E_BASE_URL, E2E_DATABASE_ADMIN_URL
 * and E2E_OUTBOUND_LOG (see support/global-setup.ts). The admin URL must point at
 * a loopback database named *e2e* unless E2E_ALLOW_REMOTE_DB=1 (SEC-P2-01).
 *
 * E2E_WEB_PORT (default 5199) moves the Vite dev server and baseURL together
 * (FU-5). Global setup refuses to start if anything already listens on it.
 */

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  // One shared database and api: tests reset the postings they touch, so run serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${resolveWebPort()}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
})
