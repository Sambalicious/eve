/**
 * Tenure, computed from the Career Profile instead of asked of a model.
 *
 * Why this exists: the extraction model pairs every mandatory prerequisite with
 * one profile fact, and it never sees a role's dates (`careerFacts()` sends the
 * title and organization only). So a plain "5+ years of software engineering
 * experience" could only ever come back uncovered, and one uncovered mandatory
 * skips the posting before coverage is looked at. Five years is arithmetic over
 * data we already store, so it is done here, deterministically.
 *
 * Scope, on purpose:
 * - Only `kind: "experience"` sections count.
 * - Months are distinct calendar months across all roles, so overlapping roles
 *   (a lead title and a side role in the same year) never inflate the total.
 * - Only plain total-experience requirements are answered ("5+ years of overall
 *   software engineering experience"). A requirement with any domain, level or
 *   extra clause ("including 3+ years in cloud computing", "at Staff level",
 *   "5+ years of experience with C++") stays unanswered here and keeps the
 *   fail-closed behaviour: only a fact can cover it.
 */

/** Month index: `year * 12 + month` with January as 0. */
export type MonthIndex = number

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

const ONGOING = new Set(["present", "current", "now", "today", "ongoing"])

const YEAR = String.raw`(\d{4})`
const MONTH = String.raw`([a-z]{3,9})`

/** One side of a period: a month and a year, or a year alone (January for a start, December for an end). */
function parseSide(value: string, edge: "start" | "end"): MonthIndex | null {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ")
  if (text === "") return null
  const monthFirst = text.match(new RegExp(`^${MONTH}\\.?,?\\s+${YEAR}$`))
  if (monthFirst) {
    const name = monthFirst[1]
    const year = monthFirst[2]
    if (name === undefined || year === undefined) return null
    const month = MONTH_NAMES[name]
    if (month === undefined) return null
    return Number(year) * 12 + month
  }
  const yearFirst = text.match(new RegExp(`^${YEAR}$`))
  if (yearFirst) {
    const year = yearFirst[1]
    if (year === undefined) return null
    return Number(year) * 12 + (edge === "start" ? 0 : 11)
  }
  const monthAfter = text.match(new RegExp(`^${YEAR}\\s+${MONTH}$`))
  if (monthAfter) {
    const year = monthAfter[1]
    const name = monthAfter[2]
    if (year === undefined || name === undefined) return null
    const month = MONTH_NAMES[name]
    if (month === undefined) return null
    return Number(year) * 12 + month
  }
  return null
}

/**
 * A role's period as month indices, `startMonth` to `endMonth` inclusive. The
 * forms the profile stores are "AUGUST 2019 – Present", "FEBRUARY 2022 –
 * February 2023", "AUGUST 2019 - August 2020" and year-only "2019 – 2020".
 * Null when it cannot be read; a caller then leaves the role out.
 */
export function parsePeriod(period: string | null, now: Date): Readonly<{ startMonth: MonthIndex; endMonth: MonthIndex }> | null {
  if (period === null) return null
  const parts = period.split(/\s*(?:[–—]|-|\bto\b)\s*/i)
  const [startText, endText] = parts
  if (parts.length !== 2 || startText === undefined || endText === undefined) return null
  const startMonth = parseSide(startText, "start")
  if (startMonth === null) return null
  const endMonth = ONGOING.has(endText.trim().toLowerCase())
    ? now.getUTCFullYear() * 12 + now.getUTCMonth()
    : parseSide(endText, "end")
  if (endMonth === null || endMonth < startMonth) return null
  return { startMonth, endMonth }
}

/** Distinct calendar months of experience across the profile's roles, as of `now`. Unreadable periods are left out. */
export function tenureMonths(sections: readonly { kind: string; period: string | null }[], now: Date): number {
  const months = new Set<MonthIndex>()
  for (const section of sections) {
    if (section.kind !== "experience") continue
    const period = parsePeriod(section.period, now)
    if (period === null) continue
    for (let month = period.startMonth; month <= period.endMonth; month += 1) months.add(month)
  }
  return months.size
}

/**
 * Words that may surround a total-experience requirement without adding another
 * requirement. A word outside this set ("including", "with", "C++", "cloud",
 * "staff") means the sentence asks for more than years, so this rule stays out.
 */
const FILLER = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "for",
  "and",
  "or",
  "plus",
  "at",
  "least",
  "overall",
  "total",
  "professional",
  "software",
  "engineering",
  "development",
  "developing",
  "building",
  "working",
  "hand",
  "hands",
  "on",
  "proven",
  "minimum",
  "practical",
  "relevant",
  "industry",
  "commercial",
  "experience",
  "years",
  "year",
  "yrs",
  "yr",
])

const YEARS_PHRASE = /\b(\d{1,2})\s*(?:\+|plus)?\s*(?:years?|yrs?)\b/g

/**
 * The years a plain total-experience requirement asks for, or null when the
 * sentence asks for anything else. "5+ years of overall software engineering
 * experience" is 5; "8+ years …, including 3+ years at Staff level" is null.
 */
export function requirementYears(text: string): number | null {
  const normalised = text.toLowerCase()
  const matches = [...normalised.matchAll(YEARS_PHRASE)]
  if (matches.length !== 1) return null
  const match = matches[0]
  if (match === undefined) return null
  const phrase = match[0]
  const digits = match[1]
  if (digits === undefined) return null
  const years = Number(digits)
  if (!Number.isInteger(years) || years < 1 || years > 40) return null
  const rest = normalised.replace(phrase, " ")
  const words = rest.replace(/[^a-z0-9+#\s]/g, " ").split(/\s+/).filter((word) => word !== "")
  if (words.length === 0) return null
  if (!words.every((word) => FILLER.has(word))) return null
  if (!words.includes("experience")) return null
  return years
}
