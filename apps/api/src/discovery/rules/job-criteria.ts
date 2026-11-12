import { normaliseTechnologyName } from "@eve/contracts"

import type { WeakReason } from "./match.js"

/** The Candidate's Job criteria in the form decisions use (EPIC-0004 AC 5.1 steps 4 and 5). */
export type DecisionCriteria = Readonly<{
  /** Whole percent, 1 to 100. */
  minCoreMatchPercent: number
  /** Canonical forms of every entry in both lists. Empty means the technology criterion is off (AC 3.6). */
  entries: ReadonlySet<string>
}>

/** Canonical forms of both lists, deduplicated, in first-seen order (what `criteria_technologies` stores). */
export function canonicalEntries(frameworks: readonly string[], technologies: readonly string[]): string[] {
  return [...new Set([...frameworks, ...technologies].map(normaliseTechnologyName))]
}

export function decisionCriteria(row: Readonly<{ minCoreMatchPercent: number; frameworks: readonly string[]; technologies: readonly string[] }>): DecisionCriteria {
  return { minCoreMatchPercent: row.minCoreMatchPercent, entries: new Set(canonicalEntries(row.frameworks, row.technologies)) }
}

export type MatchVerdict = Readonly<{ verdict: "strong" | "weak"; weakReason: WeakReason | null }>

/**
 * True when covered ÷ total ≥ percent ÷ 100, compared in integers so nothing
 * rounds (AC 2.5): 7 of 10 meets 70; 6 of 9 does not.
 */
export function meetsMinimumCoreMatch(coveredCount: number, totalCount: number, minCoreMatchPercent: number): boolean {
  return coveredCount * 100 >= minCoreMatchPercent * totalCount
}

/** The Match verdict stored in `match_evidence`: coverage only, never technologies. */
export function matchVerdict(
  counts: Readonly<{ coveredCount: number; totalCount: number; unmetMandatoryCount: number }>,
  minCoreMatchPercent: number
): MatchVerdict {
  if (counts.unmetMandatoryCount > 0) return { verdict: "weak", weakReason: "unmet_mandatory" }
  if (counts.totalCount === 0) return { verdict: "weak", weakReason: "no_core_responsibilities" }
  if (!meetsMinimumCoreMatch(counts.coveredCount, counts.totalCount, minCoreMatchPercent)) {
    return { verdict: "weak", weakReason: "coverage_below_threshold" }
  }
  return { verdict: "strong", weakReason: null }
}

export type CriteriaDecision = Readonly<{
  status: "ranked" | "skipped"
  skipReason: "weak_core_match" | "technology_mismatch" | null
  match: MatchVerdict
}>

/**
 * AC 5.1 steps 4 and 5 for a posting that passed steps 1 to 3 (eligible, every
 * mandatory prerequisite covered, at least one core responsibility). The one
 * function both the evaluator and the save-time re-decision call.
 *
 * `technologyNames` null means no technology data: never skipped for
 * technology (AC 4.5). An empty array means it mentions none (fails the
 * criterion when on). Only the first failing reason is returned.
 */
export function decideJobCriteria(
  posting: Readonly<{ coveredCount: number; totalCount: number; technologyNames: readonly string[] | null }>,
  criteria: DecisionCriteria
): CriteriaDecision {
  if (!meetsMinimumCoreMatch(posting.coveredCount, posting.totalCount, criteria.minCoreMatchPercent)) {
    return { status: "skipped", skipReason: "weak_core_match", match: { verdict: "weak", weakReason: "coverage_below_threshold" } }
  }
  const strong: MatchVerdict = { verdict: "strong", weakReason: null }
  if (criteria.entries.size > 0 && posting.technologyNames !== null) {
    const mentions = posting.technologyNames.some((name) => criteria.entries.has(normaliseTechnologyName(name)))
    if (!mentions) return { status: "skipped", skipReason: "technology_mismatch", match: strong }
  }
  return { status: "ranked", skipReason: null, match: strong }
}
