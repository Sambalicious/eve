import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  globalIgnores(["playwright-report", "test-results"]),
  {
    files: ["**/*.{ts,js}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, globals: { ...globals.node, ...globals.browser } },
    rules: {
      // E2E tests must not stub first-party responses (QA tier 3).
      "no-restricted-properties": [
        "error",
        { object: "page", property: "route", message: "No route interception of first-party calls in E2E (qa.md tier 3)." },
        { object: "context", property: "route", message: "No route interception of first-party calls in E2E (qa.md tier 3)." },
      ],
    },
  },
])
