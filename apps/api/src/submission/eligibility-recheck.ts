import { FX_RATES } from "../discovery/fx-rates.js"
import { type EligibilityPreferences, type PostingFacts, type StructuredFields, evaluateEligibility } from "../discovery/rules/eligibility.js"
import type { RuleName } from "../discovery/rules/rule-result.js"

/** What evaluation stored about a posting, enough to re-run Eligibility with no model call. */
export type StoredEligibilityFacts = Readonly<{
  title: string | null
  postingText: string
  structured: Record<string, unknown>
  arrangement: string
  relocationCountry: string | null
  employmentType: string | null
  rules: ReadonlyArray<{ rule: string; result: string; quote: string | null }>
}>

const EMPTY_STRUCTURED: StructuredFields = { workplace: null, locationRestrictions: null, pay: null, employmentType: null }

/**
 * EPIC-0002 B1 (architecture r4 :426): Eligibility re-run from stored facts
 * against the current preferences. The model's facts are not stored, so the
 * re-run uses what is: the posting text, the board's structured fields, and
 * the stored arrangement, relocation destination, employment type and rule
 * quotes (the business quote stands in for the model's business summary).
 * Returns the rules that are violated now and were not violated in the stored
 * result. Empty means keep it queued. A rule that is newly Unverified is not
 * a drop: an uncertain re-read never removes an Application.
 */
export function recheckEligibility(stored: StoredEligibilityFacts, preferences: EligibilityPreferences, on: Date): RuleName[] {
  const quote = (rule: string) => stored.rules.find((entry) => entry.rule === rule)?.quote ?? null
  const facts: PostingFacts = {
    workArrangement: stored.arrangement === "remote" || stored.arrangement === "relocation" || stored.arrangement === "onsite" ? stored.arrangement : "unclear",
    locationQuote: quote("location"),
    relocationCountry: stored.relocationCountry,
    relocationQuote: stored.arrangement === "relocation" ? quote("location") : null,
    sponsorshipQuote: quote("sponsorship"),
    payQuote: quote("pay"),
    hoursQuote: quote("hours"),
    employerBusiness: quote("industry"),
    businessQuote: quote("industry"),
    employmentType: stored.employmentType === "direct" || stored.employmentType === "employer_of_record" || stored.employmentType === "contract" ? stored.employmentType : null,
  }
  const outcome = evaluateEligibility({
    title: stored.title,
    postingText: stored.postingText,
    facts,
    structured: { ...EMPTY_STRUCTURED, ...(stored.structured as Partial<StructuredFields>) },
    preferences,
    rates: FX_RATES,
    evaluatedOn: on,
  })
  const before = new Map(stored.rules.map((entry) => [entry.rule, entry.result]))
  return (Object.keys(outcome.rules) as RuleName[]).filter((rule) => outcome.rules[rule].result === "violated" && before.get(rule) !== "violated")
}
