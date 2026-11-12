import { describe, expect, it } from "vitest"

import { flateBombPdf, manyPagesPdf, paragraphBombDocx, zipBombDocx } from "../../test/support/hostile-resumes.js"
import { buildDocx, buildPdf, buildRawDocx } from "../../test/support/resume-fixtures.js"
import { CHILD_TEST_BUDGET_MS, childTestBudget } from "../../test/support/child-test-budget.js"
import { TEST_EXTRACTION_CHILD } from "../../test/support/extraction-child.js"
import { EXTRACTION_CHILD_ENV, EXTRACTION_LIMITS, type ExtractionLimits, runResumeExtraction as runWithChild } from "./resume-text.js"

/** The production function, run with the TypeScript-source child (CR2-07: no test code in src paths). */
function runResumeExtraction(mediaType: Parameters<typeof runWithChild>[0], bytes: Buffer, limits: ExtractionLimits = EXTRACTION_LIMITS) {
  return runWithChild(mediaType, bytes, limits, TEST_EXTRACTION_CHILD)
}

/** Text or undefined, as the api treats an extraction outcome. */
async function extractResumeText(mediaType: Parameters<typeof runWithChild>[0], bytes: Buffer): Promise<string | undefined> {
  const outcome = await runResumeExtraction(mediaType, bytes)
  return outcome.ok ? outcome.text : undefined
}
import { MAX_PDF_PAGES } from "./resume-text-parsers.js"

const PDF = "application/pdf"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

describe("extractResumeText", () => {
  it("reads the text layer of a synthetic PDF", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    const text = await extractResumeText(PDF, buildPdf())
    expect(text).toContain("Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024")
  })

  it("reads the paragraphs of a synthetic DOCX", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    const text = await extractResumeText(DOCX, buildDocx())
    expect(text).toContain("Built the merchant dashboard in React and TypeScript")
  })

  it("returns undefined for a PDF with almost no text", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    expect(await extractResumeText(PDF, buildPdf(["Hi"]))).toBeUndefined()
  })

  it("returns undefined for a corrupt file instead of throwing", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    expect(await extractResumeText(DOCX, Buffer.from("PK\u0003\u0004garbage word/document.xml [Content_Types].xml"))).toBeUndefined()
  })

  it("returns undefined for text over the limit", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `Line ${i} of an unreasonably long synthetic resume text`)
    expect(await extractResumeText(DOCX, buildDocx(lines))).toBeUndefined()
  })
})

// SEC-201: parsing runs in a child process with time, heap, RSS and output bounds.
// Hostile files are generated here (never committed). Every test that spawns the
// child gets a budget derived from EXTRACTION_LIMITS (test/support/child-test-budget.ts).
describe("runResumeExtraction isolation (SEC-201)", () => {
  it("kills a child that never reports ready within the start-up limit", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    const outcome = await runResumeExtraction(DOCX, buildDocx(), { ...EXTRACTION_LIMITS, startupTimeoutMs: 1 })
    expect(outcome).toEqual({ ok: false, reason: "startup_timeout" })
  })

  it("kills a child whose parsing runs past the time limit", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    // The reason proves the parse deadline fired (not start-up, memory or the result);
    // wall-clock bounds measured host load under the full gate, not this code.
    const outcome = await runResumeExtraction(DOCX, buildDocx(Array.from({ length: 10_000 }, (_, i) => `Line ${i}`)), { ...EXTRACTION_LIMITS, timeoutMs: 1 })
    expect(outcome).toEqual({ ok: false, reason: "timeout" })
  })

  it(
    "kills a child whose resident memory passes the cap, which the V8 heap limit does not see",
    { timeout: CHILD_TEST_BUDGET_MS + 20_000 }, // parse deadline raised to 25 s
    async () => {
      // A 512 MB flate stream inflates in native buffers outside the 128 MB V8 heap.
      // Only the parent's RSS watch stops it; the deadline is raised so it cannot be
      // what fires, and the reason proves which limit did.
      const outcome = await runResumeExtraction(PDF, flateBombPdf(512), { ...EXTRACTION_LIMITS, timeoutMs: 25_000 })
      expect(outcome).toEqual({ ok: false, reason: "memory_limit" })
    }
  )

  // Linux getrusage maxRSS is inherited across fork/exec, so a child of a large parent used to
  // report the parent's size as its own peak and every resume was refused as memory_limit.
  it.skipIf(process.platform !== "linux")(
    "does not refuse a small resume because the parent holds over 400 MB (Linux only, skipped elsewhere)",
    { timeout: CHILD_TEST_BUDGET_MS },
    async () => {
      const heldByParent = Buffer.alloc(450 * 1024 * 1024, 1) // touched, so it counts as resident
      const outcome = await runResumeExtraction(DOCX, buildDocx())
      expect(heldByParent[heldByParent.length - 1]).toBe(1)
      expect(outcome.ok).toBe(true)
    }
  )

  it(
    "refuses a child that peaked over the memory cap even when no sample caught it",
    { timeout: CHILD_TEST_BUDGET_MS + 20_000 }, // parse deadline raised to 25 s
    async () => {
      // Samples are made too rare to ever fire (an hour apart), so only the child's own
      // reported peak can enforce the cap. Before the fix this came back as `too_short`
      // (the bomb decodes to an empty text layer) whenever the child finished between samples.
      // The parse deadline is raised too, so on a loaded host only the memory check can decide.
      const outcome = await runResumeExtraction(PDF, flateBombPdf(512), { ...EXTRACTION_LIMITS, rssSampleMs: 3_600_000, timeoutMs: 25_000 })
      expect(outcome).toEqual({ ok: false, reason: "memory_limit" })
    }
  )

  it("refuses a PDF with more pages than a resume, before extracting text", { timeout: childTestBudget(2) }, async () => {
    expect(await runResumeExtraction(PDF, manyPagesPdf(MAX_PDF_PAGES + 1))).toEqual({ ok: false, reason: "too_many_pages" })
    const two = await runResumeExtraction(PDF, manyPagesPdf(2))
    expect(two.ok && two.text).toContain("Led a team of 4 frontend engineers")
  })

  it.each([
    ["a 1 GB zip bomb", () => zipBombDocx(1024)],
    ["a 1 GB zip bomb whose headers lie about its size", () => zipBombDocx(1024, { lieAboutSize: true })],
    ["the reviewer's 4 million paragraph bomb", () => paragraphBombDocx(4_000_000)],
  ])("refuses %s in the DOCX preflight, before mammoth runs", { timeout: CHILD_TEST_BUDGET_MS }, async (_label, build) => {
    // The preflight reason proves mammoth never ran (a parse would end as timeout or heap_limit).
    expect(await runResumeExtraction(DOCX, build())).toEqual({ ok: false, reason: "too_large_uncompressed" })
  })

  // The parse deadline is raised to 30 s below so only the heap limit can fire.
  it("reports a child that hits the V8 heap limit as heap_limit, not as a file without text", { timeout: CHILD_TEST_BUDGET_MS + 25_000 }, async () => {
    // Within every zip limit, but mammoth's document model for 150k runs needs more than 128 MB.
    const runs = Array.from({ length: 150_000 }, (_, i) => `<w:r><w:t>${(i * 7919).toString(36)}</w:t></w:r>`).join("")
    const outcome = await runResumeExtraction(DOCX, buildRawDocx(`<w:p>${runs}</w:p>`), { ...EXTRACTION_LIMITS, timeoutMs: 30_000, rssMb: 100_000 })
    expect(outcome).toEqual({ ok: false, reason: "heap_limit" })
  })

  it("refuses output past the byte limit", { timeout: CHILD_TEST_BUDGET_MS }, async () => {
    expect(await runResumeExtraction(DOCX, buildDocx(), { ...EXTRACTION_LIMITS, maxOutputBytes: 16 })).toEqual({ ok: false, reason: "output_limit" })
  })

  it("gives the child only PATH and NODE_ENV", () => {
    expect(Object.keys(EXTRACTION_CHILD_ENV()).sort()).toEqual(["NODE_ENV", "PATH"])
  })
})
