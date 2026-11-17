import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The page reader is plain DOM code; jsdom stands in for the employer's page.
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    unstubGlobals: true,
    restoreMocks: true,
  },
})
