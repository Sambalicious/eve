import { describe, expect, it } from "vitest"

import {
  FORWARD_STATEMENT_LIMIT,
  POSTING_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  postingExtractionSchema,
  verifyExtraction,
  verifyForwardStatements,
} from "./posting-extraction.js"

const POSTING = [
  "Globex aims to reach net zero by 2030 across all its operations.",
  "We are committed to cutting emissions in half by 2035.",
  "Our campuses will run on renewable power by 2040.",
  "The board targets a fully electric fleet by 2045.",
  "You will own the carbon reporting roadmap.",
  "Contact jobs@globex.test about the net zero plan.",
  "Short one.",
  `${"A long directional statement runs on and on ".repeat(6)}.`,
].join(" ")

describe("forward statements (EPIC-0012 rule 4, design 2a)", () => {
  it("keeps an exact time-bound quote from the posting", () => {
    expect(verifyForwardStatements(["Globex aims to reach net zero by 2030"], POSTING)).toEqual(["Globex aims to reach net zero by 2030"])
  })

  it("drops a quote that is not an exact substring of the posting", () => {
    expect(verifyForwardStatements(["We will be carbon neutral by 2040"], POSTING)).toEqual([])
  })

  it("drops a quote that reads like a requirement on the applicant", () => {
    expect(verifyForwardStatements(["You will own the carbon reporting roadmap"], POSTING)).toEqual([])
    expect(verifyForwardStatements(["The role owns our net zero roadmap by 2030"], `${POSTING} The role owns our net zero roadmap by 2030.`)).toEqual([])
  })

  it("drops quotes under 20 or over 200 characters, and any holding contact detail", () => {
    expect(verifyForwardStatements(["net zero"], POSTING)).toEqual([])
    expect(verifyForwardStatements([`${"A long directional statement runs on and on ".repeat(6)}`], POSTING)).toEqual([])
    expect(verifyForwardStatements(["Contact jobs@globex.test about the net zero plan"], POSTING)).toEqual([])
  })

  it("keeps at most 3 survivors, in model order, without duplicates", () => {
    expect(
      verifyForwardStatements(
        [
          "Globex aims to reach net zero by 2030",
          "We are committed to cutting emissions in half by 2035",
          "Our campuses will run on renewable power by 2040",
          "The board targets a fully electric fleet by 2045",
        ],
        POSTING
      )
    ).toHaveLength(FORWARD_STATEMENT_LIMIT)
    expect(verifyForwardStatements(["Globex aims to reach net zero by 2030", "Globex aims to reach net zero by 2030"], POSTING)).toHaveLength(1)
  })

  it("leaves an answer without the field unchanged", () => {
    const parsed = postingExtractionSchema.safeParse({
      workArrangement: "unclear",
      locationQuote: null,
      relocationCountry: null,
      relocationQuote: null,
      sponsorshipQuote: null,
      payQuote: null,
      hoursQuote: null,
      employerBusiness: null,
      businessQuote: null,
      employmentType: null,
      coreResponsibilities: [],
      mandatoryPrerequisites: [],
      niceToHave: [],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.forwardStatements).toBeUndefined()
  })
})

describe("forward statements in the extraction", () => {
  it("asks the model for up to 3 verbatim, time-bound or directional quotes", () => {
    expect(POSTING_EXTRACTION_SYSTEM_PROMPT).toMatch(/forwardStatements: up to 3/)
    expect(POSTING_EXTRACTION_SYSTEM_PROMPT).toMatch(/verbatim quote of 20 to 200 characters/)
    expect(POSTING_EXTRACTION_SYSTEM_PROMPT).toMatch(/never a requirement on the applicant/i)
  })

  it("carries the verified quotes out of verifyExtraction", () => {
    const extraction = postingExtractionSchema.safeParse({
      workArrangement: "unclear",
      locationQuote: null,
      relocationCountry: null,
      relocationQuote: null,
      sponsorshipQuote: null,
      payQuote: null,
      hoursQuote: null,
      employerBusiness: null,
      businessQuote: null,
      employmentType: null,
      coreResponsibilities: [],
      mandatoryPrerequisites: [],
      niceToHave: [],
      forwardStatements: ["Globex aims to reach net zero by 2030", "You will own the carbon reporting roadmap"],
    })
    expect(extraction.success).toBe(true)
    if (!extraction.success) return
    expect(verifyExtraction(extraction.data, POSTING).forwardStatements).toEqual(["Globex aims to reach net zero by 2030"])
  })

  it("keeps the extraction prompt and its existing blocks as data", () => {
    const prompt = buildExtractionPrompt(POSTING, [])
    expect(prompt).toContain("<posting>")
    expect(prompt).toContain("</posting>")
  })
})
