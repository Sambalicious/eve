import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

/** ADR 0012 / EPIC-0007 threat model P1-3: the search link builders make no network request. */
const NO_OUTBOUND = "ADR 0012: search link builders only build URLs; they never make a network request (EPIC-0007 AC 3.9, 10.3)."
const OUTBOUND_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
  },
  {
    files: ["src/stack-search-links.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...OUTBOUND_GLOBALS.map((name) => ({ name, message: NO_OUTBOUND })),
      ],
      // SEC-P1-01: `globalThis.fetch` and the like bypass no-restricted-globals.
      "no-restricted-properties": [
        "error",
        ...["globalThis", "window", "self"].flatMap((object) =>
          OUTBOUND_GLOBALS.map((property) => ({ object, property, message: NO_OUTBOUND })),
        ),
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: ["node:http", "node:https", "http", "https", "undici"].map((name) => ({ name, message: NO_OUTBOUND })),
          patterns: [{ group: ["undici/*"], message: NO_OUTBOUND }],
        },
      ],
    },
  },
])
