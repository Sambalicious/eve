import { OWNER_ELIGIBILITY } from "./owner-eligibility.fixture.js"
import { describe, expect, it } from "vitest"

import type { FxTable } from "../fx-rates.js"
import { type PostingFacts, type StructuredFields, decideEligibility, evaluateEligibility } from "./eligibility.js"
import { evaluatePay } from "./pay.js"

/** Repair CR3B-01..03 (slice 3b, wave 1). Table tests written red-first. */
const RATES: FxTable = { source: "test", date: "2026-10-20", usdPerUnit: { USD: 1 } }
const FACTS: PostingFacts = {
  workArrangement: "unclear",
  locationQuote: null,
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: null,
  hoursQuote: null,
  employerBusiness: "payments software",
  businessQuote: null,
  employmentType: null,
}
const NONE: StructuredFields = { workplace: null, locationRestrictions: null, pay: null, employmentType: null }
const REMOTE_BOARD: StructuredFields = { ...NONE, workplace: "remote" }

function evaluate(text: string, structured: StructuredFields = NONE, facts: Partial<PostingFacts> = {}) {
  return evaluateEligibility({
    title: null,
    postingText: text,
    facts: { ...FACTS, ...facts },
    structured,
    preferences: OWNER_ELIGIBILITY,
    rates: RATES,
    evaluatedOn: new Date("2026-10-20T09:00:00Z"),
  })
}

describe("CR3B-01: duty wording is not relocation", () => {
  const DUTIES = [
    "You will lead our move to React Server Components.",
    "Help us move to the cloud.",
    "We are moving to a new architecture.",
    "You'll help with relocating our data centre.",
    "You will help us move to a microservices architecture.",
    "We are moving to TypeScript this year.",
    "Help the team move to Next.js.",
    "Ship features and move to production fast.",
    "Relocation assistance is not needed.",
  ]

  it.each(DUTIES)("a remote posting stays remote with: %s", (duty) => {
    expect(evaluate(`Remote, anywhere in the world. ${duty}`).arrangement).toBe("remote")
    expect(evaluate(`Senior Frontend Engineer. ${duty}`, REMOTE_BOARD).arrangement).toBe("remote")
  })

  it.each(DUTIES)("a worldwide remote posting that refuses sponsorship keeps sponsorship N/A with: %s", (duty) => {
    const outcome = evaluate(`Remote, anywhere in the world. We do not sponsor visas. ${duty}`)
    expect(outcome.rules.sponsorship.result).toBe("not_applicable")
    expect(decideEligibility(outcome).eligible).toBe(true)
  })

  it.each(DUTIES)("a Nigeria-excluding remote posting stays violated with: %s", (duty) => {
    const outcome = evaluate(`Senior Frontend Engineer. Remote (excluding Nigeria). ${duty} Salary USD 6,000 per month.`)
    expect(outcome.rules.location).toEqual({ result: "violated", quote: "Remote (excluding Nigeria)" })
    expect(decideEligibility(outcome).eligible).toBe(false)
  })

  it.each(DUTIES)("board remote data plus 'US only' stays violated with: %s", (duty) => {
    const outcome = evaluate(`Remote, US only. ${duty}`, REMOTE_BOARD, { workArrangement: "remote" })
    expect(outcome.arrangement).toBe("remote")
    expect(outcome.rules.location.result).toBe("violated")
    expect(outcome.rules.location.quote).toBe("Remote, US only")
  })

  it("an optional relocation stipend is not a required move", () => {
    expect(evaluate("Remote. We offer a relocation stipend if you ever move to our Lisbon hub, optional.").arrangement).toBe("remote")
  })
})

describe("CR3B-01: a required move to a named place is relocation", () => {
  it.each([
    ["Relocate to Berlin.", "Germany"],
    ["Relocation to Amsterdam is required.", "Netherlands"],
    ["We offer visa sponsorship and relocation to London.", "United Kingdom"],
    ["You must be willing to relocate to Toronto.", "Canada"],
    ["Remote at first, then you must relocate to Berlin. We cannot sponsor visas.", "Germany"],
    ["Remote role; relocation to Dubai required within 3 months", "United Arab Emirates"],
    ["Remote role; must move to Istanbul. Visa sponsorship provided.", "Turkey"],
    ["Remote onboarding, then relocation to Toronto with visa sponsorship", "Canada"],
  ])("%s -> relocation to %s, quoting the deciding sentence", (text, country) => {
    const outcome = evaluate(text)
    expect(outcome.arrangement).toBe("relocation")
    expect(outcome.relocationCountry).toBe(country)
    expect(text).toContain(outcome.rules.location.quote ?? "<null>")
  })

  it("a required relocation to a named place wins over board remote data", () => {
    const outcome = evaluate("Remote role; must move to Istanbul. Visa sponsorship provided.", REMOTE_BOARD)
    expect(outcome.arrangement).toBe("relocation")
    expect(outcome.rules.location.result).toBe("violated")
  })

  it.each(["Relocation required.", "You must be willing to relocate.", "Visa sponsorship and relocation package."])(
    "a relocation with no destination does not override board remote data: %s",
    (text) => {
      expect(evaluate(text, REMOTE_BOARD).arrangement).toBe("remote")
      expect(evaluate(`Remote, anywhere in the world. ${text}`).arrangement).toBe("remote")
    }
  )

  it.each([
    ["Visa sponsorship and relocation package", "met"],
    ["Relocation to Amsterdam required", "unverified"],
  ])("gherkin sponsorship rows still hold: %s", (text, result) => {
    expect(evaluate(`${text}.`).rules.sponsorship.result).toBe(result)
  })
})

describe("CR3B-02: abbreviations do not split sentences", () => {
  it.each([
    "Remote, U.S. only.",
    "This is a remote role open to U.S. residents only.",
    "Remote (U.S. based). Salary $150,000 per year.",
    "Remote, U.K. only.",
    "Remote within the E.U. only.",
    "Remote, open to U.A.E. residents only.",
    "Remote. Lagos-based candidates preferred, U.S. only for now.",
  ])("%s is violated", (text) => {
    const outcome = evaluate(text)
    expect(outcome.rules.location.result).toBe("violated")
    expect(text).toContain(outcome.rules.location.quote ?? "<null>")
  })
})

describe("CR3B-03: perks after the salary keep it the salary", () => {
  it.each([
    "Salary: $1,000 per month plus bonus.",
    "Salary: $1,000 per month + equity.",
    "Salary: $1,000 per month and stock options.",
    "Salary USD 1,000 per month plus equity and bonus.",
  ])("%s is violated at 1000.00", (text) => {
    const pay = evaluatePay({ structured: null, quote: null, postingText: `Remote. ${text}` }, RATES, OWNER_ELIGIBILITY.payFloor)
    expect(pay.result).toBe("violated")
    expect(pay.normalizedMonthlyMaxUsd).toBe("1000.00")
  })

  it.each(["A $1,000 bonus per month.", "Equity of $1,000 per month."])("a perk figure is still not pay: %s", (text) => {
    expect(evaluatePay({ structured: null, quote: null, postingText: `Remote. ${text}` }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe("unverified")
  })
})
