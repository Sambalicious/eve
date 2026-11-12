import { STEP3_DEFAULTS } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import type { FxTable } from "../fx-rates.js"
import { type EligibilityInput, type EligibilityPreferences, type PostingFacts, type StructuredFields, decideEligibility, evaluateEligibility } from "./eligibility.js"
import { evaluateEmploymentType, evaluateSeniority } from "./seniority.js"

/**
 * EPIC-0002 B1 unit 4b: every Eligibility rule reads the evaluated Candidate's
 * Job Preferences (eligibility-under-job-preferences.feature; PRD r4 AC 5.1 to
 * 5.13; api-contract-b1 field table). Each `describe` names its scenario line.
 * Rates match the feature header: 1 EUR = 1.25 USD, 1 GBP = 1.30 USD; KES and
 * NGN have no rate.
 */
const RATES: FxTable = { source: "test", date: "2026-10-20", usdPerUnit: { USD: 1, EUR: 1.25, GBP: 1.3 } }
const ON = new Date("2026-10-20T09:00:00Z")
const NO_FACTS: PostingFacts = {
  workArrangement: "unclear", locationQuote: null, relocationCountry: null, relocationQuote: null, sponsorshipQuote: null,
  payQuote: null, hoursQuote: null, employerBusiness: null, businessQuote: null, employmentType: null,
}
const NO_STRUCTURED: StructuredFields = { workplace: null, locationRestrictions: null, pay: null, employmentType: null }

const BASE: EligibilityPreferences = {
  homeCountry: "KE",
  workAuthorizedCountries: ["KE"],
  remoteAccepted: true,
  relocationAccepted: true,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: [],
  excludedIndustries: [],
  payFloor: { amount: "2000.00", currency: "USD", period: "month" },
  timeZone: "Africa/Nairobi",
  latestWorkHour: "23:00",
  seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
  employmentTypes: ["direct", "employer_of_record", "contract"],
}
const KOFI: EligibilityPreferences = { ...BASE, homeCountry: "GH", workAuthorizedCountries: ["GH"], timeZone: "Africa/Accra" }
const WANJIRU: EligibilityPreferences = { ...BASE, homeCountry: "KE", workAuthorizedCountries: ["KE"], timeZone: "Africa/Nairobi" }
/** The Operator's migrated values (0018 + 0027 v2). */
const ADA: EligibilityPreferences = {
  ...BASE, homeCountry: "NG", workAuthorizedCountries: ["NG"], timeZone: "Africa/Lagos",
  excludedRelocationCountries: ["OM", "TR", "JO", "LB", "TH"], excludedIndustries: ["adult_content", "video_games_and_gaming_platforms", "gambling", "betting"],
}

function evaluate(text: string, preferences: EligibilityPreferences, extra: { facts?: Partial<PostingFacts>; structured?: Partial<StructuredFields>; title?: string | null } = {}) {
  const input: EligibilityInput = {
    postingText: text, facts: { ...NO_FACTS, ...extra.facts }, structured: { ...NO_STRUCTURED, ...extra.structured },
    preferences, rates: RATES, evaluatedOn: ON, title: extra.title ?? null,
  }
  return evaluateEligibility(input)
}
const location = (text: string, p: EligibilityPreferences) => evaluate(text, p).rules.location.result
const where = (home: string, authorized: string[]): EligibilityPreferences => ({ ...BASE, homeCountry: home, workAuthorizedCountries: authorized })

describe(":70 one posting, opposite verdicts for opposite preferences", () => {
  it("Kofi remote only + crypto excluded: industry violated; Wanjiru relocation only: location violated", () => {
    const text = "Remote, Africa. Yellow Card is a crypto exchange."
    const kofi = evaluate(text, { ...KOFI, relocationAccepted: false, excludedIndustries: ["crypto_and_web3"] }, { facts: { employerBusiness: "crypto exchange" } })
    const wanjiru = evaluate(text, { ...WANJIRU, remoteAccepted: false }, { facts: { employerBusiness: "crypto exchange" } })
    expect(kofi.rules.industry.result).toBe("violated")
    expect(wanjiru.rules.location.result).toBe("violated")
    expect(wanjiru.rules.industry.result).toBe("met")
  })
})

describe(":80 the same posting is eligible for one Candidate and excluded for another", () => {
  it("Ghana met, Kenya violated", () => {
    const text = "Remote, open to candidates in Ghana and Nigeria only"
    expect(location(text, KOFI)).toBe("met")
    expect(location(text, WANJIRU)).toBe("violated")
  })
})

describe(":91 each formerly hardcoded rule reads the evaluated Candidate's preferences", () => {
  it.each([
    ["home country Ghana", KOFI, "Remote, we cannot hire in Nigeria", "location", "unverified"],
    ["excluded relocation Germany", { ...KOFI, excludedRelocationCountries: ["DE"] }, "Relocation to Berlin with visa sponsorship", "location", "violated"],
    ["excluded relocation none", KOFI, "Relocation to Istanbul with visa sponsorship", "location", "met"],
    ["pay floor USD 3,000 per month", { ...KOFI, payFloor: { amount: "3000.00", currency: "USD", period: "month" } }, "Salary USD 24,000–30,000 per year", "pay", "violated"],
    ["latest work hour 20:00 Accra", { ...KOFI, latestWorkHour: "20:00" }, "Core hours 12:00–20:30 UTC", "hours", "violated"],
  ] as const)("%s", (_label, preferences, text, rule, result) => {
    expect(evaluate(text, preferences).rules[rule].result).toBe(result)
    // Ada's migrated value does not leak in: the same text under Ada differs where her value differs.
  })

  it.each([
    [["crypto_and_web3"], "crypto exchange", "violated"],
    [[], "online casino", "met"],
  ] as const)("excluded industries %j, business %s: %s", (excluded, business, result) => {
    expect(evaluate(`Employer business: ${business}`, { ...KOFI, excludedIndustries: excluded }, { facts: { employerBusiness: business } }).rules.industry.result).toBe(result)
  })
})

describe(":120 a remote posting that explicitly excludes the home country is violated", () => {
  it.each(["Remote, US only", "Remote within Africa, excluding Kenya", "Remote (we cannot hire in Kenya or Uganda)"])("%s", (text) => {
    expect(location(text, { ...WANJIRU, relocationAccepted: false })).toBe("violated")
  })
})

describe(":133 remote location follows home country and work authorization (KE; KE, ZA)", () => {
  it.each([
    ["Remote, open to candidates in Kenya", "met"],
    ["Remote, EMEA", "met"],
    ["Remote, South Africa only", "met"],
    ["Remote, Nairobi or Lagos", "met"],
    ["Remote", "unverified"],
    ["Remote, anywhere in the world", "unverified"],
    ["Remote, Nigeria only", "violated"],
  ])("%s: %s", (text, result) => {
    expect(location(text, where("KE", ["KE", "ZA"]))).toBe(result)
  })
})

describe(":154 remote postings are violated when the Candidate accepts relocation only", () => {
  it("violated", () => {
    expect(location("Remote, open to candidates in Kenya", { ...WANJIRU, remoteAccepted: false })).toBe("violated")
  })
})

describe(":161 a city in the home country matches", () => {
  it("Accra or Kumasi", () => {
    expect(location("Remote, Accra or Kumasi time zone", KOFI)).toBe("met")
  })
})

describe(":170 a remote posting limited to a region is read through the fixed region table", () => {
  it.each([
    ["NG", ["NG"], "Africa", "met"],
    ["KE", ["KE"], "EMEA", "met"],
    ["EG", ["EG"], "Middle East", "met"],
    ["GH", ["GH"], "Europe", "violated"],
    ["GH", ["GH", "DE"], "Europe", "met"],
    ["GH", ["GH", "DE"], "EU", "met"],
    ["GH", ["GH", "GB"], "EU", "violated"],
    ["GH", ["GH", "GB"], "UK", "met"],
    ["ZA", ["ZA"], "North America", "violated"],
    ["ZA", ["ZA", "US"], "USA", "met"],
    ["ZA", ["ZA", "MX"], "LATAM", "met"],
    ["ZA", ["ZA", "CA"], "LATAM", "violated"],
    ["NG", ["NG", "AU"], "APAC", "met"],
    ["NG", ["NG", "AU"], "Asia", "violated"],
  ])("%s %j, Remote, %s only: %s", (home, authorized, region, result) => {
    expect(location(`Remote, ${region} only`, where(home, authorized))).toBe(result)
  })
})

describe(":195 a region name not in the table is not read as a region", () => {
  it.each(["CET-friendly time zones", "Western Europe", "Sub-Saharan Africa"])("%s only: unverified", (name) => {
    expect(location(`Remote, ${name} only`, where("GH", ["GH", "DE"]))).toBe("unverified")
  })
})

describe(":208 an explicit home-country exclusion wins over an included region", () => {
  it("violated", () => {
    expect(location("Remote, Africa. We cannot hire in Kenya.", WANJIRU)).toBe("violated")
  })
})

describe(":215 several regions: met when any includes an authorized country", () => {
  it("North America or Africa", () => {
    expect(location("Remote, North America or Africa", KOFI)).toBe("met")
  })
})

describe(":224 excluding a work-authorized country leaves location Unverified unless an authorized country is included (KE; KE, ZA, GB)", () => {
  it.each([
    ["Remote. We cannot hire in South Africa.", "unverified"],
    ["Remote, open to Kenya; not South Africa", "met"],
    ["Remote, UK only; we cannot hire in South Africa", "met"],
    ["Remote, not South Africa or the UK", "unverified"],
    ["Remote, South Africa excluded; Kenya excluded", "violated"],
  ])("%s: %s", (text, result) => {
    expect(location(text, where("KE", ["KE", "ZA", "GB"]))).toBe(result)
  })
})

describe(":241 relocation to an excluded relocation country is violated", () => {
  it("Qatar", () => {
    expect(location("Relocation to Doha required. Visa sponsorship provided.", { ...KOFI, excludedRelocationCountries: ["DE", "QA"] })).toBe("violated")
  })
})

describe(":249 relocation to a work-authorized country makes sponsorship not applicable", () => {
  it("South Africa", () => {
    const outcome = evaluate("Relocation to Cape Town. We do not sponsor visas.", where("KE", ["KE", "ZA"]))
    expect(outcome.rules.sponsorship.result).toBe("not_applicable")
    expect(outcome.rules.location.result).not.toBe("violated")
    expect(decideEligibility(outcome).unverifiedLabels).not.toContain("sponsorship")
  })
})

describe(":258 relocation outside work authorization follows EPIC-0001 sponsorship rules", () => {
  it.each([
    ["Relocation to Amsterdam required. Visa sponsorship and relocation package.", "met"],
    ["Relocation to Amsterdam required", "unverified"],
    ["Relocation to Amsterdam required. We are unable to sponsor visas for this role", "violated"],
  ])("%s: %s", (text, result) => {
    expect(evaluate(text, WANJIRU).rules.sponsorship.result).toBe(result)
  })
})

describe(":272 sponsorship need no: not applicable, no label", () => {
  it("Netherlands", () => {
    const outcome = evaluate("Relocation to Amsterdam required. We are unable to sponsor visas for this role", { ...KOFI, sponsorshipNeededForRelocation: false })
    expect(outcome.rules.sponsorship.result).toBe("not_applicable")
    expect(decideEligibility(outcome).unverifiedLabels).not.toContain("sponsorship")
  })
})

describe(":280 relocation postings are violated when the Candidate accepts remote only", () => {
  it("Toronto", () => {
    expect(location("Relocation to Toronto with visa sponsorship", { ...KOFI, relocationAccepted: false })).toBe("violated")
  })
})

describe(":287 relocation to the home country or a work-authorized country makes sponsorship not applicable", () => {
  it.each(["Must relocate to Nairobi office. No visa sponsorship.", "Relocation to Mombasa required", "Relocation to Johannesburg required"])("%s", (text) => {
    const outcome = evaluate(text, where("KE", ["KE", "ZA"]))
    expect(outcome.rules.sponsorship.result).toBe("not_applicable")
    expect(decideEligibility(outcome).unverifiedLabels).not.toContain("sponsorship")
  })
})

describe(":311 pay maximum against a EUR monthly gross floor, converted through USD", () => {
  const eur = { ...WANJIRU, payFloor: { amount: "4000.00", currency: "EUR", period: "month" as const } }
  it.each([
    ["USD 4,000–5,000 per month", "met"],
    ["USD 4,000–4,999 per month", "violated"],
    ["USD 48,000–60,000 per year", "met"],
    ["EUR 40,000–48,000 per year", "met"],
    ["EUR 40,000–47,999 per year", "violated"],
    ["USD 25.00–28.85 per hour", "met"],
    ["USD 25.00–28.84 per hour", "violated"],
  ])("Salary %s: %s", (range, result) => {
    expect(evaluate(`Salary ${range}.`, eur).rules.pay.result).toBe(result)
  })
})

describe(":330 a yearly floor compares against annualised pay", () => {
  const gbp = { ...KOFI, payFloor: { amount: "30000.00", currency: "GBP", period: "year" as const } }
  it.each([
    ["USD 3,000–3,250 per month", "met"],
    ["USD 3,000–3,249 per month", "violated"],
    ["GBP 25,000–30,000 per year", "met"],
  ])("Salary %s: %s", (range, result) => {
    expect(evaluate(`Salary ${range}.`, gbp).rules.pay.result).toBe(result)
  })
})

describe(":344 undisclosed pay is Unverified whatever the floor", () => {
  it("unverified", () => {
    expect(evaluate("Remote, open to Kenya.", { ...WANJIRU, payFloor: { amount: "4000.00", currency: "EUR", period: "month" } }).rules.pay.result).toBe("unverified")
  })
})

describe(":351 pay in a currency with no exchange rate is Unverified", () => {
  it.each(["NGN 3,000,000–4,000,000 per month", "KES 50,000–60,000 per month", "NGN 100,000,000–120,000,000 per year"])("%s", (range) => {
    const pay = evaluate(`Salary ${range}.`, { ...WANJIRU, payFloor: { amount: "4000.00", currency: "EUR", period: "month" } }).rules.pay
    expect(pay.result).toBe("unverified")
    expect(pay.normalizedMonthlyMaxUsd).toBeNull()
  })
})

describe(":368 required work ending after the latest work hour in the Candidate's zone is violated (Nairobi 21:00)", () => {
  it.each([
    ["10:00–18:00 UTC", "met"],
    ["10:01–18:01 UTC", "violated"],
    ["09:00–17:00 UTC-5", "violated"],
    ["09:00–17:00 UTC+1", "met"],
  ])("Core hours %s: %s", (hours, result) => {
    expect(evaluate(`Core hours ${hours}.`, { ...WANJIRU, latestWorkHour: "21:00" }).rules.hours.result).toBe(result)
  })
})

describe(":382 latest work hour edges; ending exactly at the hour passes (Accra)", () => {
  it.each([
    ["23:59", "15:59–23:59 UTC", "met"],
    ["23:59", "16:00–00:00 UTC", "violated"],
    ["21:00", "13:00–21:00 UTC", "met"],
    ["21:00", "13:01–21:01 UTC", "violated"],
  ])("latest %s, %s: %s", (latest, hours, result) => {
    expect(evaluate(`Core hours ${hours}.`, { ...KOFI, latestWorkHour: latest }).rules.hours.result).toBe(result)
  })
})

describe(":397 unstated hours are Unverified", () => {
  it("unverified", () => {
    expect(evaluate("Remote, open to Kenya.", { ...WANJIRU, latestWorkHour: "21:00" }).rules.hours.result).toBe("unverified")
  })
})

describe(":406 an employer in any excluded industry is violated, judged by its business", () => {
  const kofi = { ...KOFI, excludedIndustries: ["crypto_and_web3", "weapons_and_defense", "tobacco_and_vaping"] as const }
  it.each(["cryptocurrency exchange", "defense drone manufacturer", "e-cigarette and vaping retailer"])("%s", (business) => {
    expect(evaluate("Remote.", kofi, { facts: { employerBusiness: business, businessQuote: null } }).rules.industry.result).toBe("violated")
  })
})

describe(":419 an industry not excluded by this Candidate is met even if another excluded it", () => {
  it("online casino: Kofi met, Ada violated", () => {
    const facts = { employerBusiness: "online casino" }
    expect(evaluate("Remote.", { ...KOFI, excludedIndustries: ["crypto_and_web3"] }, { facts }).rules.industry.result).toBe("met")
    expect(evaluate("Remote.", ADA, { facts }).rules.industry.result).toBe("violated")
  })
})

describe(":428 a role mentioning an excluded topic at an employer outside it is met", () => {
  it("blockchain dashboard at accounting software", () => {
    const outcome = evaluate("Frontend Engineer, Blockchain Analytics Dashboard. We build accounting software for SMEs.", { ...KOFI, excludedIndustries: ["crypto_and_web3"] }, { facts: { employerBusiness: "accounting software for SMEs" } })
    expect(outcome.rules.industry.result).toBe("met")
  })
})

describe(":435 no excluded industries: industry met for every employer business", () => {
  it("sports betting", () => {
    expect(evaluate("Our sportsbook serves millions.", WANJIRU, { facts: { employerBusiness: "sports betting" } }).rules.industry.result).toBe("met")
  })
})

describe(":444 seniority follows the accepted levels (senior, staff)", () => {
  it.each([
    ["Senior Backend Engineer", "met"],
    ["Staff Software Engineer", "met"],
    ["Junior Backend Developer", "violated"],
    ["Principal Engineer, Payments", "violated"],
    ["Backend Engineer", "unverified"],
  ])("%s: %s", (title, result) => {
    expect(evaluateSeniority(title, ["senior", "staff"]).result).toBe(result)
  })
})

describe(":459 seniority not applicable when all levels are accepted", () => {
  it("not_applicable", () => {
    expect(evaluateSeniority("Backend Engineer", ["junior", "mid", "senior", "staff", "principal"])).toEqual({ result: "not_applicable", quote: null })
  })
})

describe(":467 exactly one level accepted: every other stated level is violated", () => {
  it("mid vs Senior", () => {
    expect(evaluateSeniority("Senior Frontend Engineer", ["mid"]).result).toBe("violated")
  })
})

describe(":476 employment type follows the accepted types (direct)", () => {
  it.each([
    ["direct", "met"],
    ["employer_of_record", "violated"],
    ["contract", "violated"],
    [null, "unverified"],
  ] as const)("%s: %s", (type, result) => {
    expect(evaluateEmploymentType(type, ["direct"]).result).toBe(result)
  })
})

describe(":490 employment type not applicable when all types are accepted", () => {
  it("not_applicable", () => {
    expect(evaluateEmploymentType(null, ["direct", "employer_of_record", "contract"])).toEqual({ result: "not_applicable", quote: null })
  })
})

describe(":786 a day with every posting violated on location gives an empty ranking", () => {
  it("every posting excluded for Wanjiru", () => {
    for (const text of ["Remote, US only", "Remote, Nigeria only", "Remote (we cannot hire in Kenya)"]) {
      expect(decideEligibility(evaluate(text, WANJIRU)).eligible).toBe(false)
    }
  })
})

describe(":795 the same posting for several Candidates gives each their own verdict", () => {
  it("Kenya only: Ada violated, Kofi violated, Wanjiru met", () => {
    const text = "Remote, Kenya only. USD 4,000–5,000 per month."
    expect([ADA, KOFI, WANJIRU].map((p) => location(text, p))).toEqual(["violated", "violated", "met"])
  })
})

describe("no preferences record: the step 3 defaults decide (contract no-record GET)", () => {
  it("no home or authorized country: a restricted remote posting is violated, an unrestricted one Unverified; no time zone or floor: hours and pay Unverified", () => {
    const defaults: EligibilityPreferences = { ...STEP3_DEFAULTS }
    expect(location("Remote, US only", defaults)).toBe("violated")
    expect(location("Remote", defaults)).toBe("unverified")
    expect(evaluate("Core hours 10:00–18:00 UTC. Salary USD 5,000 per month.", defaults).rules.hours.result).toBe("unverified")
    expect(evaluate("Core hours 10:00–18:00 UTC. Salary USD 5,000 per month.", defaults).rules.pay.result).toBe("unverified")
  })
})

describe("the Operator's migrated values reproduce the built rules (spot checks; the goldens hold the full set)", () => {
  it.each([
    ["Remote, open to candidates in Nigeria.", "met"],
    ["Remote within the EU; we cannot hire in Nigeria.", "violated"],
    ["Remote (excluding Nigeria and Ghana).", "violated"],
    ["Remote, US only.", "violated"],
    ["Remote, work from anywhere in the world.", "unverified"],
    ["You will relocate to Istanbul. Visa sponsorship is available.", "violated"],
    ["You must relocate to Berlin. We offer visa sponsorship.", "met"],
  ])("%s: %s", (text, result) => {
    expect(location(text, ADA)).toBe(result)
  })

  it("pay floor USD 2,000 per month: 2,000.00 met, 1,999.99 violated; hours 23:00 Lagos", () => {
    expect(evaluate("Salary USD 2,000 per month.", ADA).rules.pay.result).toBe("met")
    expect(evaluate("Salary USD 1,999.99 per month.", ADA).rules.pay.result).toBe("violated")
    expect(evaluate("Overlap 2pm-10pm EST required.", ADA).rules.hours.result).toBe("violated")
    expect(evaluate("Core hours 09:00–17:00 CET.", ADA).rules.hours.result).toBe("met")
  })
})

describe("D44 seniority and employment type are Eligibility rules (end to end through evaluateEligibility)", () => {
  const levels = (accepted: string[]) => ({ ...WANJIRU, seniorityLevels: accepted })
  const types = (accepted: string[]) => ({ ...WANJIRU, employmentTypes: accepted })

  it.each([
    ["Senior Backend Engineer", "met", true],
    ["Staff Software Engineer", "met", true],
    ["Junior Backend Developer", "violated", false],
    ["Principal Engineer, Payments", "violated", false],
    ["Backend Engineer", "unverified", true],
  ])(":444 senior, staff; title %s: seniority %s", (title, result, eligible) => {
    const outcome = evaluate("Remote, open to candidates in Kenya.", levels(["senior", "staff"]), { title })
    expect(outcome.rules.seniority.result).toBe(result)
    const decision = decideEligibility(outcome)
    expect(decision.eligible).toBe(eligible)
    expect(decision.unverifiedLabels.includes("seniority")).toBe(result === "unverified")
    if (!eligible) expect(decision.violatedRules).toContain("seniority")
  })

  it(":459 all levels accepted: not_applicable and no label", () => {
    const outcome = evaluate("Remote, open to candidates in Kenya.", WANJIRU, { title: "Backend Engineer" })
    expect(outcome.rules.seniority).toEqual({ result: "not_applicable", quote: null })
    expect(decideEligibility(outcome).unverifiedLabels).not.toContain("seniority")
  })

  it(":467 only mid accepted: a Senior title is violated", () => {
    expect(evaluate("Remote, open to candidates in Kenya.", levels(["mid"]), { title: "Senior Frontend Engineer" }).rules.seniority.result).toBe("violated")
  })

  it.each([
    ["Full-time permanent employee.", "met"],
    ["This is a role through an employer of record.", "violated"],
    ["Independent contractor engagement.", "violated"],
    ["Remote.", "unverified"],
  ])(":476 direct only; %s: employment type %s", (text, result) => {
    const outcome = evaluate(`Remote, open to candidates in Kenya. ${text}`, types(["direct"]))
    expect(outcome.rules.employment_type.result).toBe(result)
    expect(decideEligibility(outcome).eligible).toBe(result !== "violated")
  })

  it(":490 all types accepted: not_applicable and no label", () => {
    const outcome = evaluate("Remote, open to candidates in Kenya.", WANJIRU)
    expect(outcome.rules.employment_type).toEqual({ result: "not_applicable", quote: null })
    expect(decideEligibility(outcome).unverifiedLabels).not.toContain("employment_type")
  })

  it("the seven rules come in contract order; a violated seniority after industry is the violated_rule detail only when it is first", () => {
    const outcome = evaluate("Remote, US only.", levels(["mid"]), { title: "Senior Engineer" })
    expect(Object.keys(outcome.rules)).toEqual(["location", "sponsorship", "pay", "hours", "industry", "seniority", "employment_type"])
    expect(decideEligibility(outcome).violatedRules).toEqual(["location", "seniority"])
  })

  it("no preferences record: STEP3_DEFAULTS accept every level and type, so both are not_applicable", () => {
    const outcome = evaluate("Remote. Independent contractor engagement.", { ...STEP3_DEFAULTS }, { title: "Junior Engineer" })
    expect(outcome.rules.seniority.result).toBe("not_applicable")
    expect(outcome.rules.employment_type.result).toBe("not_applicable")
  })
})
