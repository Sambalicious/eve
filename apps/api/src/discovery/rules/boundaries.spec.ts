import { OWNER_ELIGIBILITY } from "./owner-eligibility.fixture.js"
import { describe, expect, it } from "vitest"

import type { FxTable } from "../fx-rates.js"
import { type PostingFacts, evaluateEligibility } from "./eligibility.js"
import { evaluatePay } from "./pay.js"

/**
 * Table tests generated over every period spelling, figure format and the
 * floor boundary (repair wave 1: the original pay and location specs were
 * never run red).
 */
const RATES: FxTable = { source: "test", date: "2026-10-20", usdPerUnit: { USD: 1, EUR: 1.25 } }

/** Max figure at the floor and one unit below it, per period (USD 2,000 a month). */
const FLOOR: ReadonlyArray<readonly [period: string, atFloor: number, below: number, spellings: readonly string[]]> = [
  ["month", 2_000, 1_999, ["/month", " /month", "/ month", "/mo", " /mo", " per month", " a month", " monthly", " p.m."]],
  ["year", 24_000, 23_999, ["/year", " / year", "/yr", " /yr", " per year", " a year", " per annum", " annually", " yearly", " p.a."]],
  ["hour", 11.54, 11.53, ["/hr", " /hr", "/ hr", "/h", " /h", "/hour", " per hour", " an hour", " hourly"]],
]

function format(value: number, style: "plain" | "comma" | "symbol"): string {
  const text = Number.isInteger(value) ? (style === "plain" ? String(value) : value.toLocaleString("en-US")) : value.toFixed(2)
  return style === "symbol" ? `$${text}` : `USD ${text}`
}

const PAY_PREFIXES = ["Salary ", "Pay: ", "Compensation: ", "Base pay ", ""]

describe("pay floor boundary over every spelling and format", () => {
  const rows: Array<[string, "met" | "violated"]> = []
  for (const [, atFloor, below, spellings] of FLOOR) {
    for (const spelling of spellings) {
      for (const style of ["plain", "comma", "symbol"] as const) {
        for (const prefix of PAY_PREFIXES) {
          rows.push([`${prefix}${format(atFloor, style)}${spelling}`, "met"])
          rows.push([`${prefix}${format(below, style)}${spelling}`, "violated"])
        }
      }
    }
  }

  it.each(rows)("%s is %s", (text, result) => {
    expect(evaluatePay({ structured: null, quote: null, postingText: `Remote role. ${text}. Apply today.` }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe(result)
  })

  it("covers every generated row", () => {
    expect(rows.length).toBe(28 * 3 * PAY_PREFIXES.length * 2)
  })
})

describe("non-pay figures never decide pay", () => {
  const DISTRACTORS = [
    "Our customers save $50,000 per year.",
    "We raised USD 40,000,000 last year.",
    "We raised $5M in our Series A.",
    "Our ARR is USD 12,000,000 a year.",
    "The product costs USD 99 per month.",
    "Teams spend $30,000 a year on tooling.",
    "We processed USD 2,000,000 in payments per month.",
    "You get a USD 3,000 signing bonus.",
    "Equity worth $40,000 per year.",
  ]

  it.each(DISTRACTORS)("alone it is Unverified: %s", (distractor) => {
    expect(evaluatePay({ structured: null, quote: null, postingText: `Remote role. ${distractor}` }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe("unverified")
  })

  it.each(DISTRACTORS.flatMap((distractor) => [
    [distractor, "Salary USD 1,500 per month.", "violated"],
    [distractor, "Salary USD 2,500 per month.", "met"],
  ]))("before a salary it is ignored: %s %s", (distractor, salary, result) => {
    expect(evaluatePay({ structured: null, quote: null, postingText: `${distractor} ${salary}` }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe(result)
  })

  it.each(DISTRACTORS)("as the model's pay quote it is not used: %s", (distractor) => {
    const postingText = `${distractor} Salary USD 1,500 per month.`
    expect(evaluatePay({ structured: null, quote: distractor, postingText }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe("violated")
  })
})

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

function location(text: string) {
  return evaluateEligibility({
    title: null,
    postingText: text,
    facts: NO_FACTS,
    structured: { workplace: "remote", locationRestrictions: null, pay: null, employmentType: null },
    preferences: OWNER_ELIGIBILITY,
    rates: RATES,
    evaluatedOn: new Date("2026-10-20T09:00:00Z"),
  }).rules.location.result
}

describe("Nigeria location boundary", () => {
  const PLACES = ["Nigeria", "Lagos", "Abuja"]
  const NEGATED = [
    (place: string) => `Candidates based in ${place} are not supported at this time.`,
    (place: string) => `Applicants in ${place} are not eligible.`,
    (place: string) => `This role is not available in ${place}.`,
    (place: string) => `We are unable to hire in ${place}.`,
    (place: string) => `We cannot hire in ${place}.`,
    (place: string) => `We can't hire in ${place} right now.`,
    (place: string) => `We do not hire in ${place}.`,
    (place: string) => `Open worldwide, excluding ${place}.`,
    (place: string) => `Open worldwide except ${place}.`,
    (place: string) => `Anyone outside of ${place} can apply.`,
    (place: string) => `Not open to candidates in ${place}.`,
  ]
  const INCLUDED = [
    (place: string) => `Open to candidates in ${place}.`,
    (place: string) => `We hire in ${place}.`,
    (place: string) => `Candidates based in ${place} are welcome.`,
    (place: string) => `Remote, ${place}`,
    (place: string) => `Remote across Africa, including ${place}.`,
  ]
  const MERELY_NAMED = [(place: string) => `We have an office in ${place}.`, (place: string) => `Our founders studied in ${place}.`]

  it.each(PLACES.flatMap((place) => NEGATED.map((make) => [make(place)])))("violated: %s", (sentence) => {
    expect(location(`Remote. ${sentence}`)).toBe("violated")
  })

  it.each(PLACES.flatMap((place) => INCLUDED.map((make) => [make(place)])))("met: %s", (sentence) => {
    expect(location(`Remote. ${sentence}`)).toBe("met")
  })

  it.each(PLACES.flatMap((place) => MERELY_NAMED.map((make) => [make(place)])))("never met: %s", (sentence) => {
    expect(location(`Remote. ${sentence}`)).toBe("unverified")
  })

  it.each(PLACES.flatMap((place) => NEGATED.map((make) => [make(place)])))("a negation wins over an inclusion elsewhere: %s", (sentence) => {
    expect(location(`Remote. Open to candidates in Nigeria. ${sentence}`)).toBe("violated")
  })
})
