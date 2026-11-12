import type { FxTable } from "../fx-rates.js"
import { type RuleResult, sentenceAround } from "./rule-result.js"

/**
 * EPIC-0002 B1 (AC 5.7): the evaluated Candidate's pay floor, from Job
 * Preferences. Amount is a 2-decimal string; period is month or year; the
 * basis is always gross. Null for a Candidate with no record: pay is then
 * Unverified, never met or violated.
 */
export type PayFloorPreference = Readonly<{ amount: string; currency: string; period: "month" | "year" }>
/** Candidate decision r1: hourly pay converts at 40 hours a week, 52 weeks a year. */
const HOURS_PER_MONTH = (40 * 52) / 12

export type PayPeriod = "hour" | "month" | "year"

export type PayRange = Readonly<{
  currency: string
  min: number | null
  max: number
  period: PayPeriod
  /** Text shown as the quote when the range came from a structured board field. */
  label?: string
}>

export type PayInput = Readonly<{
  /** Pay from the board API's own fields; preferred when present. */
  structured: PayRange | null
  /** The model's verbatim pay quote, already checked to be a substring of the posting. */
  quote: string | null
  postingText: string
}>

export type PayOutcome = Readonly<{
  result: RuleResult
  quote: string | null
  /** Normalised monthly gross maximum in USD with 2 decimals, or null when unknown. */
  normalizedMonthlyMaxUsd: string | null
  source: "structured" | "posting" | "none"
  fxRateDate: string | null
}>

const SYMBOLS: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP" }
/** Codes read as currencies; any other three capitals (ISO, UTC, SOC) are not pay. */
const CURRENCY_CODES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "CAD", "AUD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "INR", "SGD", "NZD", "ZAR",
  "JPY", "BRL", "MXN", "ILS", "TRY", "NGN", "KES", "GHS", "EGP", "AED", "SAR",
])
const CURRENCY = String.raw`(?:[A-Z]{3}|[$€£])`
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?(?:\s?[kK]\b)?`
const RANGE_SEPARATOR = String.raw`\s*(?:-|–|—|to)\s*`
const PAY_PATTERN = new RegExp(String.raw`(${CURRENCY})\s?(${NUMBER})(?:${RANGE_SEPARATOR}(?:${CURRENCY})?\s?(${NUMBER}))?`, "g")

/**
 * A period written straight after the figure. Anchored at the start of the text
 * that follows it, with no leading \b: "/" is not a word character, so a \b
 * before it never matched "/month", "/mo" or "/hr" (F-QA3-02).
 */
const FILLER = String.raw`^\s*(?:(?:gross|net|base|salary|usd|eur|gbp)\s+){0,2}`
const PERIODS: ReadonlyArray<[PayPeriod, RegExp]> = [
  ["hour", new RegExp(`${FILLER}(?:/\\s*(?:hours?|hrs?|h)\\b|(?:per|an?)\\s+hour\\b|hourly\\b|p\\.?h\\.?(?![a-z]))`, "i")],
  ["month", new RegExp(`${FILLER}(?:/\\s*(?:months?|mo)\\b|(?:per|an?)\\s+month\\b|monthly\\b|p\\.?m\\.?(?![a-z]))`, "i")],
  ["year", new RegExp(`${FILLER}(?:/\\s*(?:years?|yrs?|y)\\b|(?:per|an?)\\s+(?:year|annum)\\b|annual(?:ly)?\\b|yearly\\b|p\\.?a\\.?(?![a-z]))`, "i")],
]

/** Words that say a figure is the role's pay (F-QA3-01). */
const PAY_WORDS = /\b(salary|salaries|pay|paid|compensation|comp|base|range|ote|wage|wages|rate|remuneration)\b/i
/** Words that say a figure is something else: funding, revenue, savings, prices, perks. */
const NOT_PAY = /\b(save[sd]?|saving|savings|raised?|raising|funding|funded|series [a-f]|seed|revenue|arr|mrr|valuation|valued|costs?|price[sd]?|pricing|budget|spend|bonus|equity|stock|stipend|allowance|grant|invest\w*|customers?|turnover|profit|fees?|subscription|worth|gmv|volume|processed?)\b/i

/**
 * Reads the first pay figure or range in `text` that is in pay context: a pay
 * word earlier in its sentence, or a period written straight after it, and no
 * funding, revenue, savings, price or perk word between them (F-QA3-01). A
 * figure with a pay word and no period is read as yearly only when its maximum
 * is at least 12,000. Anything else is not used, so the result can only become
 * Unverified, never met.
 */
export function parsePayText(text: string): PayRange | null {
  return findPay(text)?.range ?? null
}

function findPay(text: string): { range: PayRange; index: number; length: number } | null {
  for (const match of text.matchAll(PAY_PATTERN)) {
    const currency = SYMBOLS[match[1] as string] ?? (match[1] as string)
    if (!CURRENCY_CODES.has(currency)) continue
    const first = amount(match[2] as string)
    const second = match[3] === undefined ? null : amount(match[3])
    const max = second ?? first
    const min = second === null ? null : first
    if (max <= 0) continue
    const end = match.index + match[0].length
    const tail = text.slice(end, end + 40)
    const prefix = clauseBefore(text, match.index)
    const stated = statedPeriod(tail)
    const lastPayWord = lastIndexOf(PAY_WORDS, prefix)
    const nonPayAfterPayWord = NOT_PAY.test(prefix.slice(Math.max(lastPayWord, 0)))
    // Only the figure's own clause counts: "; bonus ..." after a salary is about the next figure.
    // "plus bonus", "+ equity", "and stock options" add perks to the salary; they don't make it a perk (CR3B-03).
    const ownTail = (tail.slice(0, 25).split(/[;.!?\n]/)[0] ?? "").split(/\s*(?:\bplus\b|\+|\band\b|\bwith\b|,)\s*/)[0] ?? ""
    if (nonPayAfterPayWord || NOT_PAY.test(ownTail)) continue
    const period = stated ?? (lastPayWord >= 0 && max >= 12_000 ? "year" : null)
    if (period !== null) return { range: { currency, min, max, period }, index: match.index, length: match[0].length }
  }
  return null
}

function statedPeriod(tail: string): PayPeriod | null {
  for (const [period, pattern] of PERIODS) if (pattern.test(tail)) return period
  return null
}

/** Text from the start of the figure's sentence (or clause after ";") up to the figure. */
function clauseBefore(text: string, index: number): string {
  let start = index
  while (start > 0 && !/[!?;\n]/.test(text[start - 1] as string) && !/\.\s/.test(text.slice(start - 1, start + 1))) start -= 1
  return text.slice(start, index)
}

function lastIndexOf(pattern: RegExp, text: string): number {
  let last = -1
  for (const match of text.matchAll(new RegExp(pattern.source, "gi"))) last = match.index
  return last
}

/** Computes the pay rule in code. The model only points at text; it cannot set the result. */
export function evaluatePay(input: PayInput, rates: FxTable, floor: PayFloorPreference | null): PayOutcome {
  if (input.structured) {
    return outcomeFor(input.structured, input.structured.label ?? null, "structured", rates, floor)
  }
  for (const candidate of [input.quote, input.postingText]) {
    if (!candidate) continue
    const found = findPay(candidate)
    if (!found) continue
    const quote = candidate === input.quote ? input.quote : sentenceAround(candidate, found.index, found.length)
    return outcomeFor(found.range, quote, "posting", rates, floor)
  }
  return { result: "unverified", quote: null, normalizedMonthlyMaxUsd: null, source: "none", fxRateDate: null }
}

function outcomeFor(range: PayRange, quote: string | null, source: "structured" | "posting", rates: FxTable, floor: PayFloorPreference | null): PayOutcome {
  const usdPerUnit = rates.usdPerUnit[range.currency.toUpperCase()]
  if (usdPerUnit === undefined) {
    return { result: "unverified", quote, normalizedMonthlyMaxUsd: null, source, fxRateDate: null }
  }
  const cents = Math.round(monthly(range.max, range.period) * usdPerUnit * 100)
  const floorCents = floor === null ? null : floorMonthlyUsdCents(floor, rates)
  return {
    result: floorCents === null ? "unverified" : cents >= floorCents ? "met" : "violated",
    quote,
    normalizedMonthlyMaxUsd: (cents / 100).toFixed(2),
    source,
    fxRateDate: range.currency.toUpperCase() === "USD" ? null : rates.date,
  }
}

/**
 * The floor as monthly gross USD cents. Comparing in USD is the same order as
 * converting the posting's maximum through USD into the floor's currency and
 * period (AC 5.7): both sides are scaled by the same positive rate. A USD
 * monthly floor of 2000.00 is 200000, the built constant, so the Operator's
 * results are unchanged. A floor currency without a rate gives null.
 */
export function floorMonthlyUsdCents(floor: PayFloorPreference, rates: FxTable): number | null {
  const usdPerUnit = rates.usdPerUnit[floor.currency.toUpperCase()]
  if (usdPerUnit === undefined) return null
  const amount = Number.parseFloat(floor.amount)
  return Math.round((floor.period === "year" ? amount / 12 : amount) * usdPerUnit * 100)
}

function monthly(value: number, period: PayPeriod): number {
  if (period === "hour") return value * HOURS_PER_MONTH
  if (period === "year") return value / 12
  return value
}

function amount(raw: string): number {
  const trimmed = raw.replace(/[,\s]/g, "")
  const thousands = /k$/i.test(trimmed)
  const value = Number.parseFloat(thousands ? trimmed.slice(0, -1) : trimmed)
  return thousands ? value * 1000 : value
}
