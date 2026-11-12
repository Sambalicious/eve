import { requirementYears } from "./tenure.js"

export type MatchItem = Readonly<{
  text: string
  factId: string | null
  /** A total-experience requirement covered by the profile's computed tenure, not by one fact. */
  byTenure?: true
}>

export type MatchInput = Readonly<{
  core: readonly MatchItem[]
  mandatory: readonly MatchItem[]
  niceToHave: readonly MatchItem[]
}>

export type WeakReason = "unmet_mandatory" | "coverage_below_threshold" | "no_core_responsibilities"

/** Match evidence before any Job criteria apply (EPIC-0004: the threshold is the Candidate's, read at verdict time). */
export type MatchOutcome = Readonly<{
  core: MatchItem[]
  mandatory: MatchItem[]
  niceToHave: MatchItem[]
  coveredCount: number
  totalCount: number
  unmetMandatory: string[]
}>

/**
 * AC 4.10 to 4.12, in code. A fact ID counts only if it is in the approved
 * Career Profile; anything else becomes "not covered". Nice-to-have items
 * never change the verdict. The strong/weak line is applied later by
 * `matchVerdict` (rules/job-criteria.ts) with the Candidate's minimum core
 * Match; there is no backend default (EPIC-0004 AC 2.4).
 *
 * A mandatory prerequisite with no fact is still unmet unless it is a plain
 * total-experience requirement and the profile's own months of experience reach
 * it (`rules/tenure.ts`, so no model is asked to add up dates). Domain, level or
 * otherwise qualified requirements are never answered this way.
 */
export function evaluateMatch(input: MatchInput, approvedFactIds: ReadonlySet<string>, tenureMonths = 0): MatchOutcome {
  const keep = (item: MatchItem): MatchItem => ({
    text: item.text,
    factId: item.factId !== null && approvedFactIds.has(item.factId) ? item.factId : null,
  })
  const coveredByTenure = (item: MatchItem): MatchItem => {
    if (item.factId !== null) return item
    const years = requirementYears(item.text)
    if (years === null || tenureMonths < years * 12) return item
    return { ...item, byTenure: true as const }
  }
  const core = input.core.map(keep)
  const mandatory = input.mandatory.map(keep).map(coveredByTenure)
  const niceToHave = input.niceToHave.map(keep)
  return {
    core,
    mandatory,
    niceToHave,
    coveredCount: core.filter((item) => item.factId !== null).length,
    totalCount: core.length,
    unmetMandatory: mandatory.filter((item) => item.factId === null && item.byTenure !== true).map((item) => item.text),
  }
}
