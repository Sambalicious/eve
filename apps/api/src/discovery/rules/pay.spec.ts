import { OWNER_ELIGIBILITY } from "./owner-eligibility.fixture.js"
import { describe, expect, it } from "vitest"

import { type FxTable, FX_RATES } from "../fx-rates.js"
import { evaluatePay, parsePayText } from "./pay.js"

const RATES: FxTable = { source: "test", date: "2026-10-20", usdPerUnit: { USD: 1, EUR: 1.25, GBP: 1.3 } }

function payFrom(text: string, rates: FxTable = RATES) {
  return evaluatePay({ structured: null, quote: text, postingText: text }, rates, OWNER_ELIGIBILITY.payFloor)
}

describe("pay floor USD 2,000 per month gross (AC 4.5)", () => {
  it.each([
    ["USD 1,500–2,000 per month gross", "met"],
    ["USD 1,500–1,999 per month gross", "violated"],
    ["USD 18,000–24,000 per year", "met"],
    ["USD 18,000–23,999 per year", "violated"],
    ["USD 2,500–4,000 per month gross", "met"],
  ])("%s is %s", (range, result) => {
    expect(payFrom(range).result).toBe(result)
  })

  it.each([
    ["USD 10.00–11.54 per hour", "2000.27", "met"],
    ["USD 10.00–11.53 per hour", "1998.53", "violated"],
    ["USD 30–40 per hour", "6933.33", "met"],
  ])("hourly %s normalises to %s a month at 40 h/week", (range, monthly, result) => {
    const pay = payFrom(range)
    expect(pay.normalizedMonthlyMaxUsd).toBe(monthly)
    expect(pay.result).toBe(result)
  })

  it.each([
    ["EUR 15,000–19,200 per year", "2000.00", "met"],
    ["EUR 15,000–19,199 per year", "1999.90", "violated"],
    ["GBP 40,000–55,000 per year", "5958.33", "met"],
  ])("converts %s to USD at the dated rate", (range, monthly, result) => {
    const pay = payFrom(range)
    expect(pay.normalizedMonthlyMaxUsd).toBe(monthly)
    expect(pay.result).toBe(result)
  })

  it("undisclosed pay is Unverified", () => {
    expect(payFrom("Remote Frontend Engineer. Build our React app.").result).toBe("unverified")
  })

  it("a currency missing from the rate table is Unverified, never guessed", () => {
    expect(payFrom("NGN 900,000–1,200,000 per month").result).toBe("unverified")
  })

  it("prefers structured board fields over the posting text", () => {
    const pay = evaluatePay(
      {
        structured: { currency: "USD", min: 60_000, max: 80_000, period: "year", label: "USD 60,000–80,000 per year" },
        quote: "USD 1,000 per month",
        postingText: "USD 1,000 per month",
      },
      RATES,
      OWNER_ELIGIBILITY.payFloor
    )
    expect(pay.result).toBe("met")
    expect(pay.source).toBe("structured")
  })

  it("scans the posting text when the model found no pay quote (keyword floor)", () => {
    const text = "Great team. Salary USD 18,000–23,999 per year. Apply now."
    expect(evaluatePay({ structured: null, quote: null, postingText: text }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe("violated")
  })

  it("reads k suffixes, dollar signs and single figures", () => {
    expect(parsePayText("$90k - $120k per year")).toMatchObject({ currency: "USD", min: 90_000, max: 120_000, period: "year" })
    expect(parsePayText("Up to €5,000 a month")).toMatchObject({ currency: "EUR", max: 5_000, period: "month" })
  })

  it("ships a dated ECB rate table with its source", () => {
    expect(FX_RATES.date).toBe("2026-10-16")
    expect(FX_RATES.source).toContain("ecb.europa.eu")
    expect(FX_RATES.usdPerUnit.USD).toBe(1)
    expect(FX_RATES.usdPerUnit.EUR).toBeCloseTo(1.1253, 4)
  })
})

describe("repair wave 1: pay only from pay context (F-QA3-01)", () => {
  const scan = (text: string) => evaluatePay({ structured: null, quote: null, postingText: text }, RATES, OWNER_ELIGIBILITY.payFloor)

  it.each([
    ["Our customers save $50,000 per year. Pay: USD 1,500 per month.", "violated", "1500.00"],
    ["We raised USD 40,000,000 last year. Salary USD 1,200 per month.", "violated", "1200.00"],
    ["Our ARR passed USD 3,000,000 a year. Compensation: USD 1,000–1,800 per month.", "violated", "1800.00"],
    ["Salary USD 1,200 per month, plus a USD 20,000 signing bonus.", "violated", "1200.00"],
  ])("ignores non-pay figures: %s", (text, result, monthly) => {
    const pay = scan(text)
    expect(pay.result).toBe(result)
    expect(pay.normalizedMonthlyMaxUsd).toBe(monthly)
  })

  it.each([
    "Our customers save $50,000 per year.",
    "We raised $5M in our Series A.",
    "We raised USD 40,000,000 last year.",
    "Remote. USD 24,000.",
    "Our product costs USD 99 per month.",
  ])("no confident pay figure is Unverified, never met: %s", (text) => {
    const pay = scan(text)
    expect(pay.result).toBe("unverified")
    expect(pay.normalizedMonthlyMaxUsd).toBeNull()
  })

  it.each([
    ["Pay range: USD 60,000 - 80,000", "met"],
    ["Base salary USD 20,000", "violated"],
    ["OTE $90k", "met"],
    ["Remote. USD 24,000/yr.", "met"],
  ])("pay words or an explicit period make a figure count: %s", (text, result) => {
    expect(scan(text).result).toBe(result)
  })

  it("a model quote that is a non-pay figure is not used", () => {
    const pay = evaluatePay({ structured: null, quote: "We raised $5M", postingText: "We raised $5M. Salary USD 1,200 per month." }, RATES, OWNER_ELIGIBILITY.payFloor)
    expect(pay.result).toBe("violated")
  })
})

describe("repair wave 1: compact period suffixes (F-QA3-02)", () => {
  it.each([
    ["USD 13,000/month", "month", 13_000],
    ["USD 13,000 / month", "month", 13_000],
    ["USD 2,000/mo", "month", 2_000],
    ["USD 2,000 /mo", "month", 2_000],
    ["$5,000/month", "month", 5_000],
    ["USD 11.54/hr", "hour", 11.54],
    ["USD 11.54 / hr", "hour", 11.54],
    ["USD 30/h", "hour", 30],
    ["USD 30 /h", "hour", 30],
    ["USD 24000/yr", "year", 24_000],
    ["USD 24,000 / yr", "year", 24_000],
    ["USD 24,000/year", "year", 24_000],
    ["USD 24,000 / year", "year", 24_000],
    ["$24k/yr", "year", 24_000],
    ["USD 24,000 p.a.", "year", 24_000],
  ])("%s is %s", (text, period, max) => {
    expect(parsePayText(text)).toMatchObject({ period, max })
  })

  it.each([
    ["Pay: USD 13,000/month", "met", "13000.00"],
    ["Pay: USD 11.54/hr", "met", "2000.27"],
    ["Pay: USD 11.53/hr", "violated", "1998.53"],
    ["Pay: USD 2,000/mo", "met", "2000.00"],
    ["Pay: USD 1,999/mo", "violated", "1999.00"],
  ])("%s is %s at %s a month", (text, result, monthly) => {
    const pay = payFrom(text)
    expect(pay.result).toBe(result)
    expect(pay.normalizedMonthlyMaxUsd).toBe(monthly)
  })

  it("the model quote 'USD 13,000/month' is monthly", () => {
    const text = "Remote. Pay: USD 13,000/month."
    expect(evaluatePay({ structured: null, quote: "Pay: USD 13,000/month", postingText: text }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe("met")
  })
})

describe("repair wave 2: a non-pay word in the next clause does not drop the salary (security probe N)", () => {
  it.each([
    ["Base salary USD 1,000 per month; bonus up to USD 3,000 per month.", "violated", "1000.00"],
    ["Salary USD 2,500 per month. Equity worth USD 900 per month.", "met", "2500.00"],
  ])("%s", (text, result, monthly) => {
    const pay = evaluatePay({ structured: null, quote: null, postingText: `Remote. ${text}` }, RATES, OWNER_ELIGIBILITY.payFloor)
    expect(pay.result).toBe(result)
    expect(pay.normalizedMonthlyMaxUsd).toBe(monthly)
  })

  it("the model's bonus quote is not used", () => {
    const postingText = "Remote. Base salary USD 1,000 per month; bonus up to USD 3,000 per month."
    expect(evaluatePay({ structured: null, quote: "bonus up to USD 3,000 per month", postingText }, RATES, OWNER_ELIGIBILITY.payFloor).result).toBe("violated")
  })
})
