import { defineConfig } from "vitest/config"

const INTEGRATION_TIMEOUT_MS = 120_000

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.spec.ts", "test/**/*.spec.ts"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int-spec.ts", "test/**/*.int-spec.ts"],
          testTimeout: INTEGRATION_TIMEOUT_MS,
          hookTimeout: INTEGRATION_TIMEOUT_MS,
          // One Postgres container per run; each file gets its own database from a template.
          globalSetup: ["test/support/postgres.global-setup.ts"],
        },
      },
    ],
  },
})
