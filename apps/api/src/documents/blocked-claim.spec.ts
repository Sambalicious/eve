import { describe, expect, it } from "vitest"

import { writtenClaims } from "../career-profile/claim-check.js"
import { collectTerms, describeBlock, storedTerms } from "./blocked-claim.js"
import type { DocumentValidation } from "./document-claims.js"

/**
 * EPIC-0009: the blocked alert's cause and terms. The owner's reproduction is the first test.
 */
const REDDIT =
  "I work well in remote teams. I acted as the main frontend partner to product, backend and testing teams and cut implementation rework by 50%. At another company, I cut production crashes by 25%."

function failed(overrides: Partial<Extract<DocumentValidation, { ok: false }>> = {}): Extract<DocumentValidation, { ok: false }> {
  return { ok: false, reason: "unsupported_claim", claim: REDDIT, unsupported: ["remote"], hardFail: "claim_word", ...overrides }
}

describe("describeBlock: the owner's Reddit Application", () => {
  it("reports one unsupported term, as written, with nothing overflowed", () => {
    expect(describeBlock(failed())).toEqual({ cause: "unsupported_terms", terms: ["remote"], moreTerms: 0 })
  })

  it("files a claim word as unsupported_terms, not as a missing fact", () => {
    expect(describeBlock(failed({ hardFail: "claim_word" })).cause).toBe("unsupported_terms")
  })
})

describe("causeOf: one cause per remedy (OD-1)", () => {
  it.each([
    ["contact_detail", undefined, "contact_detail"],
    ["unknown_fact", undefined, "unknown_fact"],
    ["no_fact", undefined, "no_fact"],
    ["names_target", "names_target", "names_target"],
  ] as const)("reason %s maps to %s", (reason, hardFail, expected) => {
    expect(describeBlock(failed({ reason, hardFail, unsupported: [] })).cause).toBe(expected)
  })

  it.each(["claim_word", "gap", "role_noun", "borrowed_name", "posting_term", "support_inflation", "completion_word", "unsourced_quote"] as const)(
    "hard fail %s folds into unsupported_terms",
    (hardFail) => {
      expect(describeBlock(failed({ hardFail })).cause).toBe("unsupported_terms")
    }
  )

  it("a number-order failure is its own cause", () => {
    expect(describeBlock(failed({ hardFail: "number", unsupported: ["2", "3"] })).cause).toBe("number_order")
  })

  it("a failure with no hard fail is not_confirmed, and shows no list", () => {
    expect(describeBlock(failed({ hardFail: undefined, unsupported: ["led"] }))).toEqual({
      cause: "not_confirmed",
      terms: null,
      moreTerms: null,
    })
  })

  it("reason wins over a hard fail the cause does not own (OD-5)", () => {
    expect(describeBlock(failed({ reason: "names_target", hardFail: "names_target" })).cause).toBe("names_target")
  })

  it("every cause except the three terms causes stores no terms at all", () => {
    for (const cause of ["contact_detail", "names_target", "unknown_fact"] as const) {
      expect(describeBlock(failed({ reason: cause, unsupported: ["x"] })).terms).toBeNull()
    }
    expect(describeBlock(failed({ hardFail: undefined, unsupported: ["x"] })).terms).toBeNull()
  })
})

describe("terms are shown as written in the paragraph (PRD 1.2)", () => {
  it("keeps a month name instead of its claim-check number", () => {
    expect(collectTerms("Senior Engineer at Globex, June 2021 to now", ["6"]).terms).toEqual(["June"])
  })

  it("keeps a magnitude instead of its expanded number", () => {
    expect(collectTerms("Reached 1.5m users", ["1500000"]).terms).toEqual(["1.5m"])
  })

  it("keeps a company abbreviation instead of its expansion", () => {
    expect(collectTerms("Staff Engineer at Brightwave Ltd", ["limited"]).terms).toEqual(["Ltd"])
  })

  it("keeps a percentage as written", () => {
    expect(collectTerms("Cut implementation rework by 50%.", ["50"]).terms).toEqual(["50"])
  })

  it("shows a term once and in paragraph order, whatever order the validator returned", () => {
    expect(collectTerms("remote teams, remote work, kubernetes", ["kubernetes", "remote"]).terms).toEqual(["remote", "kubernetes"])
  })

  it("de-duplicates case-insensitively", () => {
    expect(collectTerms("Remote work and remote teams", ["remote"]).terms).toEqual(["Remote"])
  })

  it("leaves out a term the paragraph no longer holds", () => {
    expect(collectTerms("Cut rework by 50%.", ["remote"])).toEqual({ terms: [], moreTerms: 0 })
  })

  it("round-trips every located term through the tokeniser", () => {
    for (const written of writtenClaims(REDDIT)) {
      expect(writtenClaims(written.text).some((again) => again.value === written.value)).toBe(true)
    }
  })
})

describe("caps and overflow (PRD 1.6, OD-4)", () => {
  const many = Array.from({ length: 23 }, (_, index) => `term${String.fromCharCode(97 + index)}`)
  const paragraph = many.join(" and ")

  it("stores 20 terms and counts the rest", () => {
    const { terms, moreTerms } = collectTerms(paragraph, many)
    expect(terms).toHaveLength(20)
    expect(moreTerms).toBe(3)
  })

  it("counts an oversized term instead of dropping it silently", () => {
    const long = `a${"b".repeat(140)}`
    expect(collectTerms(`${long} appears here`, [long])).toEqual({ terms: [], moreTerms: 1 })
  })
})

describe("storedTerms: a stored row can never fail the contract (TM-0009-04)", () => {
  it("drops a term that no longer parses and counts it", () => {
    expect(storedTerms("unsupported_terms", ["ok", "", "b".repeat(121)], 0)).toEqual({ terms: ["ok"], moreTerms: 2 })
  })

  it("sends no terms with a cause that shows no list", () => {
    expect(storedTerms("names_target", ["remote"], 1)).toEqual({ terms: null, moreTerms: null })
    expect(storedTerms(null, null, null)).toEqual({ terms: null, moreTerms: null })
  })

  it("keeps an unknown cause's terms out of the response but does not throw", () => {
    expect(storedTerms("future_cause", ["remote"], 0)).toEqual({ terms: null, moreTerms: null })
  })
})

describe("an astral character before a term does not corrupt the stored term (EPIC-0009 repair)", () => {
  it("stores Zorvex, not a clipped slice", () => {
    const claim = "\u{1F600}\u{1F600}\u{1F600} We shipped Zorvex to customers."
    expect(describeBlock(failed({ claim, unsupported: ["zorvex"] }))).toEqual({ cause: "unsupported_terms", terms: ["Zorvex"], moreTerms: 0 })
  })
})
