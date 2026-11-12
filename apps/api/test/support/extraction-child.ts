import { fileURLToPath } from "node:url"

import type { ExtractionChild } from "../../src/career-profile/resume-text.js"

/**
 * Runs the extraction child from TypeScript source under Vitest: Node's type
 * stripping plus a resolve hook for `./x.js` → `./x.ts`. Production runs the
 * compiled `dist/career-profile/extract-text.child.js` instead.
 */
export const TEST_EXTRACTION_CHILD: ExtractionChild = {
  nodeArgs: [
    "--experimental-strip-types",
    "--no-warnings=ExperimentalWarning",
    "--import",
    fileURLToPath(new URL("./ts-source-hook.mjs", import.meta.url)),
  ],
  script: fileURLToPath(new URL("../../src/career-profile/extract-text.child.ts", import.meta.url)),
}
