import { describe, expect, it } from "vitest"

import { EXTRACTION_LIMITS, type ExtractionChild, runResumeExtraction } from "../src/career-profile/resume-text.js"
import { TEST_EXTRACTION_CHILD } from "./support/extraction-child.js"
import { buildPdf } from "./support/resume-fixtures.js"

/**
 * The parse deadline must bound parsing only, not Node start-up and module import,
 * which took 3.2-3.9 s on this machine with every core busy. Start-up is made slow
 * deterministically: the child first runs a 2 s busy loop (`--import` of a module
 * that blocks), while the parse deadline is 1 s. Before the fix the deadline counted
 * from spawn, so this was refused as `timeout`; now it counts from the child's
 * "ready" line. (A CPU-saturation version of this test starved the rest of the suite.)
 */
const SLOW_STARTUP_CHILD: ExtractionChild = {
  ...TEST_EXTRACTION_CHILD,
  nodeArgs: [
    ...TEST_EXTRACTION_CHILD.nodeArgs,
    "--import",
    "data:text/javascript,const end=Date.now()+2000;while(Date.now()<end){}",
  ],
}

describe("extraction deadline and child start-up", () => {
  it("does not count a slow child start-up against the parse deadline", async () => {
    const outcome = await runResumeExtraction("application/pdf", buildPdf(), { ...EXTRACTION_LIMITS, timeoutMs: 1_000 }, SLOW_STARTUP_CHILD)
    expect(outcome.ok).toBe(true)
  })

  it("still bounds start-up separately", async () => {
    const outcome = await runResumeExtraction("application/pdf", buildPdf(), { ...EXTRACTION_LIMITS, startupTimeoutMs: 500 }, SLOW_STARTUP_CHILD)
    expect(outcome).toEqual({ ok: false, reason: "startup_timeout" })
  })
})
