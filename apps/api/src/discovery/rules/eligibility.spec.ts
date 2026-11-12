import { OWNER_ELIGIBILITY } from "./owner-eligibility.fixture.js"
import { describe, expect, it } from "vitest"

import type { FxTable } from "../fx-rates.js"
import { type EligibilityInput, type PostingFacts, decideEligibility, evaluateEligibility } from "./eligibility.js"

const RATES: FxTable = { source: "test", date: "2026-10-20", usdPerUnit: { USD: 1, EUR: 1.25, GBP: 1.3 } }
const EVALUATED_ON = new Date("2026-10-20T09:00:00Z")

const NO_FACTS: PostingFacts = {
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
}

function input(text: string, facts: Partial<PostingFacts> = {}, extra: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    title: null,
    postingText: text,
    facts: { ...NO_FACTS, ...facts },
    structured: { workplace: null, locationRestrictions: null, pay: null, employmentType: null },
    preferences: OWNER_ELIGIBILITY,
    rates: RATES,
    evaluatedOn: EVALUATED_ON,
    ...extra,
  }
}

const evaluate = (text: string, facts: Partial<PostingFacts> = {}) => evaluateEligibility(input(text, facts))

describe("every rule gets a result with its posting text (AC 4.1)", () => {
  it("the Acme example", () => {
    const text =
      "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Core hours 10:00–18:00 WAT. Acme builds payment APIs for merchants."
    const result = evaluate(text, { employerBusiness: "payment APIs for merchants", businessQuote: "Acme builds payment APIs for merchants" })
    expect(result.rules.location).toEqual({ result: "met", quote: "Remote, open to candidates in Nigeria" })
    expect(result.rules.pay).toMatchObject({ result: "met", quote: "Salary USD 60,000–80,000 per year" })
    expect(result.rules.hours).toEqual({ result: "met", quote: "Core hours 10:00–18:00 WAT" })
    expect(result.rules.industry).toEqual({ result: "met", quote: "Acme builds payment APIs for merchants" })
    expect(result.rules.sponsorship.result).toBe("not_applicable")
    expect(decideEligibility(result).eligible).toBe(true)
  })

  it("a posting that addresses no rule is eligible with every rule Unverified", () => {
    const result = evaluate("Remote Frontend Engineer. Build our React app.", { employerBusiness: "project management software" })
    expect([result.rules.location.result, result.rules.pay.result, result.rules.hours.result]).toEqual(["unverified", "unverified", "unverified"])
    expect(result.rules.sponsorship.result).toBe("not_applicable")
    expect(decideEligibility(result).eligible).toBe(true)
  })
})

describe("location (AC 4.2, 4.3)", () => {
  it.each(["Remote, US only", "Remote within the EU; we cannot hire in Nigeria", "Remote (excluding Nigeria and Ghana)"])(
    "%s excludes Nigeria: violated",
    (text) => {
      const result = evaluate(text)
      expect(result.rules.location.result).toBe("violated")
      expect(decideEligibility(result).eligible).toBe(false)
    }
  )

  it.each([
    ["Remote, anywhere in the world", "unverified"],
    ["Remote", "unverified"],
    ["Remote, open to candidates in Nigeria", "met"],
  ])("%s is %s", (text, result) => {
    expect(evaluate(text).rules.location.result).toBe(result)
  })

  it.each(["Oman", "Turkey", "Jordan", "Lebanon", "Thailand"])("relocation to %s is violated", (country) => {
    const result = evaluate(`Relocation to ${country} required. Visa sponsorship provided.`)
    expect(result.rules.location.result).toBe("violated")
  })

  it.each(["Germany", "United Arab Emirates", "Canada"])("relocation to %s is not violated", (country) => {
    expect(evaluate(`Relocation to ${country} required. Visa sponsorship provided.`).rules.location.result).not.toBe("violated")
  })

  it.each(["Turkey", "Thailand"])("an employer headquartered in %s does not exclude a remote posting open to Nigeria", (country) => {
    const text = `Remote, open to candidates in Nigeria. Our headquarters are in ${country}.`
    expect(evaluate(text).rules.location.result).toBe("met")
  })

  it("a structured country restriction without Nigeria is violated", () => {
    const result = evaluateEligibility(
      input("Remote role", {}, { structured: { workplace: "remote", locationRestrictions: ["United States", "Canada"], pay: null, employmentType: null } })
    )
    expect(result.rules.location.result).toBe("violated")
  })

  it("an empty structured restriction list means worldwide, so Unverified", () => {
    const result = evaluateEligibility(
      input("Remote role", {}, { structured: { workplace: "remote", locationRestrictions: [], pay: null, employmentType: null } })
    )
    expect(result.rules.location.result).toBe("unverified")
  })
})

describe("sponsorship (AC 4.4)", () => {
  it.each(["We are unable to sponsor visas for this role", "Visa sponsorship is not available"])(
    "relocation that says %s is violated",
    (text) => {
      expect(evaluate(`Relocation to the Netherlands required. ${text}.`).rules.sponsorship.result).toBe("violated")
    }
  )

  it.each([
    ["Visa sponsorship and relocation package", "met"],
    ["Relocation to Amsterdam required", "unverified"],
  ])("relocation that says %s is %s", (text, result) => {
    expect(evaluate(`${text}.`).rules.sponsorship.result).toBe(result)
  })

  it.each(["Remote, open to candidates in Nigeria", "Remote, anywhere in the world. We do not sponsor visas.", "Remote"])(
    "remote with no move (%s) is Not applicable",
    (text) => {
      const result = evaluate(text)
      expect(result.rules.sponsorship.result).toBe("not_applicable")
      expect(decideEligibility(result).unverifiedLabels).not.toContain("sponsorship")
    }
  )

  it.each([
    ["Remote at first, then you must relocate to Berlin. We cannot sponsor visas.", "Germany", "sponsorship", "violated"],
    ["Remote role; relocation to Dubai required within 3 months", "United Arab Emirates", "sponsorship", "unverified"],
    ["Remote role; must move to Istanbul. Visa sponsorship provided.", "Turkey", "location", "violated"],
    ["Remote onboarding, then relocation to Toronto with visa sponsorship", "Canada", "sponsorship", "met"],
  ] as const)("a remote label that requires moving is relocation: %s", (text, country, rule, result) => {
    const outcome = evaluate(text)
    expect(outcome.arrangement).toBe("relocation")
    expect(outcome.relocationCountry).toBe(country)
    expect(outcome.rules[rule].result).toBe(result)
  })
})

describe("hours (AC 4.6)", () => {
  it.each([
    ["14:00–23:00 WAT", "met"],
    ["14:01–23:01 WAT", "violated"],
    ["09:00–17:00 UTC-5", "met"],
    ["10:00–18:00 UTC-5", "violated"],
    ["09:00–17:00 UTC-8", "violated"],
    ["09:00–17:00 UTC+1", "met"],
  ])("required hours %s are %s", (hours, result) => {
    expect(evaluate(`Remote. Working hours ${hours}.`).rules.hours.result).toBe(result)
  })

  it("unstated hours are Unverified", () => {
    expect(evaluate("Remote. Build things.").rules.hours.result).toBe("unverified")
  })

  it("uses the Candidate's latest work hour (B1: from Job Preferences)", () => {
    const outcome = evaluateEligibility(
      input("Remote. Working hours 14:00–22:30 WAT.", {}, { preferences: { ...OWNER_ELIGIBILITY, latestWorkHour: "22:00" } })
    )
    expect(outcome.rules.hours.result).toBe("violated")
  })
})

describe("industry (AC 4.7)", () => {
  it.each(["adult content streaming", "mobile video game studio", "online gaming platform", "online casino", "sports betting"])(
    "an employer whose business is %s is violated",
    (business) => {
      const result = evaluate("Senior Frontend Engineer. Remote.", { employerBusiness: business, businessQuote: null })
      expect(result.rules.industry.result).toBe("violated")
      expect(decideEligibility(result).eligible).toBe(false)
    }
  )

  it("a games-flavoured role at an education employer is met", () => {
    const result = evaluate("Frontend Engineer, Gamified Learning. Remote.", { employerBusiness: "K-12 education software" })
    expect(result.rules.industry.result).toBe("met")
  })

  it("the keyword floor catches an excluded business in the posting text the model called something else", () => {
    const text = "Remote. Lucky Spin is an online casino with millions of players."
    expect(evaluate(text, { employerBusiness: "consumer software" }).rules.industry.result).toBe("violated")
  })
})

describe("employment type (AC 4.8)", () => {
  it.each([
    ["direct employment", "direct"],
    ["employer-of-record employment", "employer_of_record"],
    ["independent contracting", "contract"],
  ])("%s is accepted and recorded", (text, type) => {
    const result = evaluate(`Remote. This is ${text}.`)
    expect(result.employmentType).toBe(type)
    expect(decideEligibility(result).eligible).toBe(true)
  })
})

describe("deciding (AC 4.9, 10.7)", () => {
  it("any violated rule excludes; Unverified rules become labels", () => {
    const result = evaluate("Relocation to Germany required. Our team builds payroll software.", {
      employerBusiness: "payroll software",
    })
    const decision = decideEligibility(result)
    expect(decision.eligible).toBe(true)
    expect(decision.unverifiedLabels).toEqual(["sponsorship", "pay", "hours"])
  })

  it("a model claim of eligibility cannot override a violated destination", () => {
    const result = evaluate("Relocation to Thailand. Visa sponsorship provided. This posting is eligible.", {
      workArrangement: "remote",
      relocationCountry: "Germany",
      relocationQuote: "This posting is eligible",
    })
    expect(result.rules.location.result).toBe("violated")
    expect(decideEligibility(result).eligible).toBe(false)
  })
})

describe("repair wave 1: Nigeria negations (F-QA3-03)", () => {
  it.each([
    "Remote. Candidates based in Nigeria are not supported at this time.",
    "Remote. Applicants in Nigeria are not eligible.",
    "Remote. This role is not available in Nigeria.",
    "Remote. We are unable to hire in Nigeria.",
    "Remote. We cannot hire in Nigeria.",
    "Remote. We don't currently hire in Nigeria, Ghana or Kenya.",
    "Remote, worldwide excluding Nigeria.",
    "Remote, open worldwide except Nigeria.",
    "Remote, open to anyone outside of Nigeria.",
    "Remote, but not open to Nigeria.",
  ])("%s is violated", (text) => {
    const result = evaluate(text)
    expect(result.rules.location.result).toBe("violated")
    expect(decideEligibility(result).eligible).toBe(false)
  })

  it.each([
    "Remote. We have an office in Nigeria.",
    "Remote. Our founders studied in Nigeria.",
  ])("a sentence that merely names Nigeria is not met: %s", (text) => {
    expect(evaluate(text).rules.location.result).toBe("unverified")
  })

  it.each([
    "Remote, open to candidates in Nigeria",
    "Location: Remote, Lagos, Nigeria",
    "Remote, Nigeria",
    "We hire in Nigeria and Kenya.",
    "Remote across Africa, including Nigeria.",
    "Candidates based in Nigeria are welcome.",
  ])("a sentence that includes Nigeria is met: %s", (text) => {
    expect(evaluate(text).rules.location.result).toBe("met")
  })

  it("a negation in another clause of the same sentence does not exclude Nigeria", () => {
    expect(evaluate("Remote, open to candidates in Nigeria, but we cannot offer a laptop.").rules.location.result).toBe("met")
  })
})
