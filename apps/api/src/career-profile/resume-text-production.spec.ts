import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { buildDocx } from "../../test/support/resume-fixtures.js"
import { CHILD_TEST_BUDGET_MS } from "../../test/support/child-test-budget.js"
import { TEST_EXTRACTION_CHILD } from "../../test/support/extraction-child.js"
import { EXTRACTION_LIMITS, runResumeExtraction } from "./resume-text.js"

const SOURCE = readFileSync(fileURLToPath(new URL("./resume-text.ts", import.meta.url)), "utf8")
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// CR2-07: production modules carry no test-only code and do not block the event loop.
describe("resume-text production module (CR2-07)", () => {
  it("does not reference test support files or TypeScript stripping", () => {
    expect(SOURCE).not.toMatch(/test\/support|ts-source-hook|experimental-strip-types/)
  })

  it("has no synchronous child-process or file calls", () => {
    expect(SOURCE).not.toMatch(/execFileSync|readFileSync|spawnSync|existsSync/)
  })

  it("samples the child's memory with asynchronous calls only", () => {
    // Deterministic replacement for a loop-lag timing check, which measured host
    // scheduling under the full gate (97 ms with every core busy) rather than this code.
    expect(SOURCE).toMatch(/await readFile\(`\/proc\/\$\{pid\}\/status`/)
    expect(SOURCE).toMatch(/await execFileAsync\("ps"/)
  })

  it("reads a resume while sampling memory every millisecond", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i} of a longer synthetic resume`)
    const outcome = await runResumeExtraction(DOCX, buildDocx(lines), { ...EXTRACTION_LIMITS, rssSampleMs: 1 }, TEST_EXTRACTION_CHILD)
    expect(outcome.ok).toBe(true)
  })
})
