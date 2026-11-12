import { describe, expect, it } from "vitest"

import { claimWords, numbersIn, writtenClaims } from "../career-profile/claim-check.js"
import { describeBlock, storedTerms } from "./blocked-claim.js"
import type { DocumentValidation } from "./document-claims.js"

/**
 * EPIC-0009 QA gate (independent of the implementation session). Each row feeds `describeBlock` the
 * validator output the Gherkin marks [V] (measured at 3d36603b) and asserts the [L] as-written terms
 * the Gherkin pins for the D1 locator (token match, then literal match, sort, de-duplicate, OD-4 120
 * rule, cap 20). Scenario IDs are from gherkin/blocked-claim-detail.r1.feature.
 */
type Failed = Extract<DocumentValidation, { ok: false }>
const block = (claim: string, unsupported: string[], hardFail: string | undefined, reason: Failed["reason"] = "unsupported_claim"): Failed =>
  ({ ok: false, reason, claim, unsupported, ...(hardFail === undefined ? {} : { hardFail }) }) as Failed

const LAGOS = "I led the Lagos office migration from June 2021 to Present and saved 1.5m in costs."
const REDDIT =
  "I work well in remote teams. I acted as the main frontend partner to product, backend and testing teams and cut implementation rework by 50%. At another company, I cut production crashes by 25%."
const SPAN_120 = "we rebuilt every merchant dashboard screen for speed and clarity across the entire product, in all regions every quarter"
const SPAN_121 = "we rebuilt every merchant dashboard screen for speed and clarity across the entire product, in all regions, every quarter"

describe("QA EPIC-0009: token-located terms (@ac-1.2, @ac-1.3, @ac-1.8, @ac-1.9, @ac-2.2, @ac-2.3, @ac-8.8)", () => {
  it.each([
    ["@ac-1.2 r1", LAGOS, ["lagos", "office", "migration", "6", "2021", "present", "1500000"], "claim_word", "unsupported_claim", ["Lagos", "office", "migration", "June", "2021", "Present", "1.5m"]],
    ["@ac-1.2 r2 / @ac-8.8", "Staff Engineer at Brightwave Ltd", ["staff", "engineer", "brightwave", "limited"], undefined, "no_fact", ["Staff", "Engineer", "Brightwave", "Ltd"]],
    ["@ac-1.2 r3", "Built wind farm models in Tableau, forecasting revenue and cost.", ["tableau"], "borrowed_name", "unsupported_claim", ["Tableau"]],
    ["@ac-1.2 r4", "Built wind farm financial models for offshore projects with other Consultants.", ["consultants"], "role_noun", "unsupported_claim", ["Consultants"]],
    ["@ac-1.2 r5 / @ac-10.1 P10", "Led the payments migration", ["led"], "support_inflation", "unsupported_claim", ["Led"]],
    ["@ac-1.2 r6 / @ac-8.8", "Increased revenue by 40%", ["revenue", "40"], "claim_word", "unsupported_claim", ["revenue", "40"]],
    ["@ac-1.2 r7 / @ac-8.8", "Senior Frontend Engineer, 2018–2024", ["2018"], "claim_word", "unsupported_claim", ["2018"]],
    ["@ac-1.3 r1", "Built a React and TypeScript merchant dashboard with GraphQL, then graphql caching and Zorvex, then ZORVEX.", ["graphql", "caching", "zorvex"], "claim_word", "unsupported_claim", ["GraphQL", "caching", "Zorvex"]],
    ["@ac-1.8 r1", "I have 10 years of Kubernetes experience.", ["10", "kubernetes"], undefined, "no_fact", ["10", "Kubernetes"]],
    ["@ac-1.8 r2", "Expert in Kubernetes and Terraform", ["expert", "kubernetes", "terraform"], undefined, "no_fact", ["Expert", "Kubernetes", "Terraform"]],
    ["@ac-1.9 r1", "Built a React and TypeScript merchant dashboard for Zorvex with real care", ["zorvex"], "claim_word", "unsupported_claim", ["Zorvex"]],
    ["@ac-1.9 r4", "Built a React and TypeScript merchant dashboard for 40 merchants with real care", ["40"], "claim_word", "unsupported_claim", ["40"]],
    ["@ac-1.9 r5", "I built wind farm financial models for offshore projects with stakeholder alignment, forecasting revenue and cost.", ["stakeholder", "alignment"], "claim_word", "unsupported_claim", ["stakeholder", "alignment"]],
    ["@ac-2.2 r1 / @ac-2.3", "I cut our release cycle from 2 days to 3 weeks", ["2", "3"], "number", "unsupported_claim", ["2", "3"]],
    ["@ac-2.2 r2", "Cut release cycle from 2 days to 2 weeks", ["2", "2"], "number", "unsupported_claim", ["2"]],
    ["@ac-8.8 AWS", "AWS Certified Solutions Architect", ["aws", "certified", "solutions", "architect"], "claim_word", "unsupported_claim", ["AWS", "Certified", "Solutions", "Architect"]],
    ["@ac-10.1 P5", "Your plan to “halve operational emissions by 2030” is clear. I met the target. I built wind farm financial models for offshore projects, forecasting revenue and cost.", ["met"], "completion_word", "unsupported_claim", ["met"]],
    ["@ac-10.1 P9", "I built wind farm financial models for offshore projects with stakeholder alignment and roadmap work, forecasting revenue and cost.", ["stakeholder", "alignment", "roadmap"], "posting_term", "unsupported_claim", ["stakeholder", "alignment", "roadmap"]],
    ["@ac-10.1 P15 / @ac-1.5", REDDIT, ["remote"], "claim_word", "unsupported_claim", ["remote"]],
  ] as const)("%s", (_id, claim, internal, hardFail, reason, shown) => {
    const result = describeBlock(block(claim, [...internal], hardFail, reason))
    expect(result.terms).toEqual(shown)
    expect(result.moreTerms).toBe(0)
    for (const term of result.terms ?? []) expect(claim.toLowerCase()).toContain(term.toLowerCase())
  })
})

describe("QA EPIC-0009: span terms need the D1 literal match (@ac-10.1 P4/P6, @ac-10.11, @ac-10.12, @ac-1.6 OD-4, @ac-8.6)", () => {
  it("@ac-10.12 / @ac-10.1 P4: a quotation is one item, as written", () => {
    expect(describeBlock(block('I will "cut water use by 40" for the group.', ["cut water use by 40"], "unsourced_quote"))).toEqual({ cause: "unsupported_terms", terms: ["cut water use by 40"], moreTerms: 0 })
  })

  it.each([
    ["@ac-10.11 r1 / @ac-10.1 P6", "Built wind farm models with carbon accounting, forecasting revenue and cost.", ["carbon accounting"]],
    ["@ac-10.11 r2", "Built wind farm models with Carbon Accounting, forecasting revenue and cost.", ["Carbon Accounting"]],
    ["@ac-10.11 r3 / @ac-1.4 r1", "Built wind farm models, accounting for carbon, forecasting revenue and cost.", []],
  ] as const)("%s: a gap keyword is shown only when found as written", (_id, claim, shown) => {
    expect(describeBlock(block(claim, ["carbon accounting"], "gap"))).toEqual({ cause: "unsupported_terms", terms: shown, moreTerms: 0 })
  })

  it("@ac-1.4 r2: a borrowed name the line spells differently is not shown", () => {
    expect(describeBlock(block("Built wind farm models for E.S.G. reporting, forecasting revenue and cost.", ["esg"], "borrowed_name"))).toEqual({ cause: "unsupported_terms", terms: [], moreTerms: 0 })
  })

  it("@ac-1.6 r1 (120 units): the span is stored whole", () => {
    expect(SPAN_120).toHaveLength(120)
    expect(describeBlock(block(`I said "${SPAN_120}" to the group.`, [SPAN_120], "unsourced_quote"))).toEqual({ cause: "unsupported_terms", terms: [SPAN_120], moreTerms: 0 })
  })

  it("@ac-1.6 r2 (121 units, OD-4): the span is left out but counted", () => {
    expect(SPAN_121).toHaveLength(121)
    expect(describeBlock(block(`I said "${SPAN_121}" to the group.`, [SPAN_121], "unsourced_quote"))).toEqual({ cause: "unsupported_terms", terms: [], moreTerms: 1 })
  })

  it("@ac-8.6 r2: a raw <…> span is one term, exactly as returned", () => {
    const claim = "I built a React and TypeScript merchant dashboard with Zorvex <script>alert(1)</script>"
    expect(describeBlock(block(claim, ["script>alert(1)</script"], "unsourced_quote")).terms).toEqual(["script>alert(1)</script"])
  })
})

describe("QA EPIC-0009: cap and overflow (@ac-1.6)", () => {
  const zeta = (n: number) => Array.from({ length: n }, (_, i) => `Zeta${String.fromCharCode(97 + i)}word`)
  it.each([
    [10, 10, 0],
    [20, 20, 0],
    [21, 20, 1],
    [23, 20, 3],
  ])("%i distinct values: %i listed, %i counted", (returned, listed, more) => {
    const words = returned === 10 ? ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett"] : zeta(returned)
    const claim = `I used ${words.join(" ")} daily.`
    const result = describeBlock(block(claim, words.map((w) => w.toLowerCase()), "claim_word"))
    expect(result.terms).toEqual(words.slice(0, listed))
    expect(result.moreTerms).toBe(more)
  })
})

describe("QA EPIC-0009: causes outside the path table (@ac-10.10, OD-5 / contract A-2, A-4)", () => {
  it("@ac-10.10: an unknown hard fail stores no kind and no terms", () => {
    const result = describeBlock(block("I built Zorvex dashboards.", ["zorvex"], "future_code"))
    expect(result.cause).toBeNull()
    expect(result.terms).toBeNull()
    expect(result.moreTerms).toBeNull()
  })

  it("OD-5 / A-4: unsupported_claim with hard fail names_target is names_target, with no list", () => {
    expect(describeBlock(block("I want to bring that to Reddit.", [], "names_target"))).toEqual({ cause: "names_target", terms: null, moreTerms: null })
  })

  it("@ac-1.4 [S]: one unlocatable value is left out, the other shown, count 0", () => {
    expect(describeBlock(block("I built Zorvex dashboards.", ["zorvex", "kubra"], "claim_word"))).toEqual({ cause: "unsupported_terms", terms: ["Zorvex"], moreTerms: 0 })
  })
})

describe("QA EPIC-0009: no-list causes (@ac-3.1, @ac-4.1, @ac-5.1, @ac-9.1, @ac-9.3)", () => {
  it.each([
    ["@ac-3.1 P1", block("You can reach me at sam@example.com for references from Brightwave Ltd.", [], undefined, "contact_detail"), "contact_detail"],
    ["@ac-4.1 P3", block("I built a React and TypeScript merchant dashboard and want to bring that to Reddit.", [], "names_target", "names_target"), "names_target"],
    ["@ac-5.1 P2", block("Staff Engineer at Brightwave Ltd", [], undefined, "unknown_fact"), "unknown_fact"],
    ["@ac-9.1 P11", block("I mentored 6 junior developers through the year.", [], undefined), "not_confirmed"],
    ["@ac-9.1/9.3 P12", block("Drove the move of the billing service to Kubernetes", ["drove"], undefined), "not_confirmed"],
    ["@ac-9.1 P12 built", block("Built a React and TypeScript merchant dashboard with real care", ["built"], undefined), "not_confirmed"],
  ] as const)("%s", (_id, validation, cause) => {
    expect(describeBlock(validation)).toEqual({ cause, terms: null, moreTerms: null })
  })
})

describe("QA EPIC-0009: read guard (TM-0009-04, OD-7)", () => {
  it("drops an empty and an over-long stored term and counts both", () => {
    expect(storedTerms("unsupported_terms", ["", "ok", "x".repeat(121)], 2)).toEqual({ terms: ["ok"], moreTerms: 4 })
  })
  it("sends no terms for a no-list cause or an unknown cause, whatever is stored", () => {
    expect(storedTerms("not_confirmed", ["drove"], 0)).toEqual({ terms: null, moreTerms: null })
    expect(storedTerms("some_future_kind", ["Zorvex"], 2)).toEqual({ terms: null, moreTerms: null })
  })
})

describe("QA EPIC-0009: tokeniser equivalence (@ac-7.2 Gherkin [L] note)", () => {
  const lines = [
    LAGOS,
    REDDIT,
    "Senior Frontend Engineer, 2018–2024",
    "Built a React and TypeScript merchant dashboard with GraphQL, then graphql caching and Zorvex, then ZORVEX.",
    "I cut our release cycle from 2 days to 3 weeks",
    "Café ﬁnance team, ᴄᴀᴘs and ex­ample, ongoing since March 2020",
    "Your plan to “halve operational emissions by 2030” is clear. I met the target.",
  ]
  it.each(lines)("writtenClaims agrees with claimWords and numbersIn, and every span is in the line: %s", (line) => {
    const written = writtenClaims(line)
    for (const w of written) expect(line.slice(w.start, w.end)).toBe(w.text)
    const values = written.map((w) => w.value)
    for (const word of claimWords(line)) expect(values).toContain(word)
    for (const n of numbersIn(line)) expect(values).toContain(n)
  })
})
