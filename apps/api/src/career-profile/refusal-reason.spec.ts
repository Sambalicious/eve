import { describe, expect, it } from "vitest"

import { KNOWN_EXTRACTION_REASONS, type KnownExtractionReason, REFUSAL_REASON_BY_KNOWN, refusalReasonFor } from "./refusal-reason.js"

// The dashboard picks C-PROFILE-4a..4d / C-PROFILE-4 from this value (design-spec.r3.md).
describe("refusalReasonFor", () => {
  it.each([
    ["too_many_pages", "pages"],
    ["too_long", "characters"],
    ["too_much_text", "characters"],
    ["output_limit", "characters"],
    ["too_many_entries", "docx_limits"],
    ["too_large_uncompressed", "docx_limits"],
    ["compression_ratio", "docx_limits"],
    ["timeout", "parse_limits"],
    ["memory_limit", "parse_limits"],
    ["heap_limit", "parse_limits"],
    ["startup_timeout", "parse_limits"],
    ["too_short", "no_text"],
    ["not_a_docx", "no_text"],
    ["InvalidPDFException", "no_text"],
    ["child_failed", "no_text"],
  ] as const)("%s -> %s", (internal, reason) => {
    expect(refusalReasonFor(internal)).toBe(reason)
  })
})

describe("CR-03: the map is typed by the known reason union", () => {
  it("maps every known extraction reason explicitly", () => {
    for (const reason of KNOWN_EXTRACTION_REASONS) {
      expect(REFUSAL_REASON_BY_KNOWN[reason]).toMatch(/^(pages|characters|docx_limits|parse_limits|no_text)$/)
    }
  })

  it("is a total map over the union", () => {
    const total: Record<KnownExtractionReason, string> = REFUSAL_REASON_BY_KNOWN
    expect(Object.keys(total).sort()).toEqual([...KNOWN_EXTRACTION_REASONS].sort())
  })
})
