import { defineConfig } from "vitest/config"

/** Live-check only (EPIC-0012). Not part of `vitest run`; calls the real Anthropic API. Run with the key in the environment. */
export default defineConfig({
  test: { include: ["scripts/live-check/*.live.ts"], testTimeout: 600_000, hookTimeout: 60_000, fileParallelism: false },
})
