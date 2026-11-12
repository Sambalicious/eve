import { OWNER_ELIGIBILITY } from "./owner-eligibility.fixture.js"
import { describe, expect, it } from "vitest"

import type { FxTable } from "../fx-rates.js"
import { type PostingFacts, type StructuredFields, decideEligibility, evaluateEligibility } from "./eligibility.js"
import { sentencesOf } from "./rule-result.js"

/**
 * Slice 5 prework, before automatic submission (scope Unit 0 items 1 to 4):
 * F-QA3B-03, SEC-309, SEC-311 (with the CR3B-01 residual probes), CR3B-06 and
 * CR3B-07. Every change is in the exclusion direction only.
 */
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

describe("F-QA3B-03: a structured 'Remote' does not override office text", () => {
  it("W2-ON-STRUCT: board remote plus 'San Francisco office, 5 days a week' and no sponsorship is excluded", () => {
    const outcome = evaluate("Join our San Francisco office, 5 days a week. We are unable to sponsor visas.", REMOTE_BOARD)
    expect(outcome.arrangement).not.toBe("remote")
    expect(outcome.rules.sponsorship.result).toBe("violated")
    expect(decideEligibility(outcome).eligible).toBe(false)
  })

  it.each([
    "Office 3 days a week. No visa sponsorship.",
    "This role is onsite in Berlin. No visa sponsorship.",
    "You will work in the office in London. We cannot sponsor visas.",
  ])("board remote plus office text, no sponsorship, is excluded: %s", (text) => {
    expect(decideEligibility(evaluate(text, REMOTE_BOARD)).eligible).toBe(false)
  })

  it("S1: Greenhouse 'Location: San Francisco (Hybrid, remote optional)' read as board remote is excluded", () => {
    const text = "Senior Frontend Engineer\nLocation: San Francisco (Hybrid, remote optional)\nOffice 3 days a week. No visa sponsorship."
    expect(decideEligibility(evaluate(text, REMOTE_BOARD)).eligible).toBe(false)
    expect(decideEligibility(evaluate("Senior Frontend Engineer\nLocation: San Francisco (Hybrid, remote optional)\nNo visa sponsorship.", REMOTE_BOARD)).eligible).toBe(false)
  })

  it("the model's onsite reading also wins over board remote", () => {
    const outcome = evaluate("Engineer. We do not sponsor visas.", REMOTE_BOARD, { workArrangement: "onsite" })
    expect(outcome.arrangement).not.toBe("remote")
    expect(outcome.rules.sponsorship.result).toBe("violated")
  })

  it("board remote with no office text stays remote", () => {
    const outcome = evaluate("Remote, anywhere in the world. We do not sponsor visas.", REMOTE_BOARD, { workArrangement: "remote" })
    expect(outcome.arrangement).toBe("remote")
    expect(outcome.rules.sponsorship.result).toBe("not_applicable")
  })
})

describe("SEC-309: more onsite phrasings", () => {
  it.each([
    ["B1", "Remote role. Hybrid: remote 2 days, the rest from the Berlin HQ. We cannot sponsor visas."],
    ["B2", "Remote-friendly, but you must come into the London HQ every week. We cannot sponsor visas."],
    ["B3", "Remote role. Office attendance required Tuesday to Thursday. We cannot sponsor visas."],
    ["B5", "Remote role. You must live within commuting distance of Paris. We cannot sponsor visas."],
    ["headquarters", "Remote role, working from our headquarters in Austin twice a month. We cannot sponsor visas."],
    ["commute", "Remote first, but you will commute to our Lisbon hub weekly. We cannot sponsor visas."],
  ])("%s ranks no more: %s", (_id, text) => {
    for (const facts of [{ workArrangement: "remote" as const }, { workArrangement: "unclear" as const }]) {
      const outcome = evaluate(text, NONE, facts)
      expect(outcome.arrangement).not.toBe("remote")
      expect(decideEligibility(outcome).eligible).toBe(false)
    }
  })

  it.each([
    "Remote, open to candidates in Nigeria. Our headquarters are in Turkey.",
    "Remote, anywhere in the world. No commute, ever.",
    "Remote, anywhere in the world. Skip the commute and work from home.",
    "Remote, anywhere in the world. You will build our hybrid cloud platform.",
  ])("a remote posting stays remote: %s", (text) => {
    expect(evaluate(text).arrangement).toBe("remote")
  })
})

describe("SEC-311: a named move does not lift remote restrictions unless it is required", () => {
  it.each([
    ["R1", "Remote, US only. Many of our engineers move to Austin eventually."],
    ["R3", "Remote role, but we cannot hire in Nigeria. You could relocate to Berlin later."],
    ["R7", "Remote, US only. You will help customers relocate to Germany."],
    ["CR3B-01 residual a", "Remote (excluding Nigeria). We help families move to the UK."],
    ["eventually", "Remote, EU only. Most of the team relocate to Lisbon eventually."],
  ])("%s stays excluded on location: %s", (_id, text) => {
    const outcome = evaluate(text)
    expect(outcome.rules.location.result).toBe("violated")
    expect(decideEligibility(outcome).eligible).toBe(false)
  })

  it("H1: board restriction ['United States'] plus duty text naming Germany stays violated", () => {
    const outcome = evaluate("You will help customers relocate to Germany.", { ...REMOTE_BOARD, locationRestrictions: ["United States"] })
    expect(outcome.arrangement).toBe("remote")
    expect(outcome.rules.location.result).toBe("violated")
  })

  it("CR3B-01 residual b: duty text naming a place is not a relocation", () => {
    const outcome = evaluate("Remote, anywhere in the world. We do not sponsor visas. Our app helps students move to Canada.")
    expect(outcome.arrangement).toBe("remote")
    expect(outcome.rules.sponsorship.result).toBe("not_applicable")
    expect(decideEligibility(outcome).eligible).toBe(true)
  })

  it("CR3B-01 residual c: not a relocation; 'Germany-based' still reads as a region restriction (over-exclusion kept)", () => {
    const outcome = evaluate("Remote, anywhere in the world. We do not sponsor visas. Help us move to Germany-based data centres.")
    expect(outcome.arrangement).toBe("remote")
    expect(outcome.rules.sponsorship.result).toBe("not_applicable")
    expect(outcome.rules.location.result).toBe("violated")
  })

  it("board remote plus 'help us move to Germany-based data centres' is still remote", () => {
    expect(evaluate("Help us move to Germany-based data centres.", REMOTE_BOARD).arrangement).toBe("remote")
  })

  it.each([
    ["We cannot hire in Nigeria; you must relocate to Berlin. Visa sponsorship provided.", "Germany"],
    ["Remote, US only at first. You are required to relocate to Toronto within 3 months. Visa sponsorship provided.", "Canada"],
  ])("a clearly required move (requirement word + destination) decides location: %s", (text, country) => {
    const outcome = evaluate(text)
    expect(outcome.arrangement).toBe("relocation")
    expect(outcome.relocationCountry).toBe(country)
    expect(outcome.rules.location.result).toBe("met")
  })
})

describe("CR3B-06: short forms do not split sentences", () => {
  it.each([
    ["Acme Inc. builds APIs", ["Acme Inc. builds APIs"]],
    ["Contact Dr. Smith", ["Contact Dr. Smith"]],
    ["Globex Ltd. is hiring. Remote", ["Globex Ltd. is hiring", "Remote"]],
    ["We use React, Vue, etc. and more", ["We use React, Vue, etc. and more"]],
    ["Pay is approx. $5,000 per month", ["Pay is approx. $5,000 per month"]],
  ])("%s", (text, sentences) => {
    expect(sentencesOf(text)).toEqual(sentences)
  })
})

describe("CR3B-07: the pronoun 'us' is not the United States", () => {
  it.each([
    "Remote, anywhere in the world. Send your CV to us only through the careers page.",
    "Remote, anywhere in the world. Talk to us only after applying.",
    "Remote, anywhere in the world. Join us only if you love payments.",
  ])("stays Unverified: %s", (text) => {
    expect(evaluate(text).rules.location.result).toBe("unverified")
  })

  it.each(["Remote, US only.", "Remote, U.S. only.", "Remote, open to US residents only.", "Remote within the US only."])(
    "the country is still a restriction: %s",
    (text) => {
      expect(evaluate(text).rules.location.result).toBe("violated")
    }
  )
})
