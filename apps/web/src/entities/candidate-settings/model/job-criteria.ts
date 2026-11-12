import type { RoleFamilyValue, SeniorityFloor } from "@eve/contracts"

export type { SeniorityFloor }
/** One of the 13 role family keys (contract v1.18.0). */
export type TargetRoleFamily = RoleFamilyValue

/**
 * The Candidate's Job criteria (EPIC-0004, contract v1.13.0): the minimum core
 * Match and the two technology lists Eve applies when it decides a posting.
 */
export interface JobCriteria {
  /** Whole number 1 to 100. */
  readonly minCoreMatchPercent: number
  /** Trimmed, as typed, in the order saved. */
  readonly frameworks: readonly string[]
  readonly technologies: readonly string[]
  /** v1.18.0: 1 to 13 families, catalog order. Postings in other families are hidden. */
  readonly targetRoleFamilies: readonly TargetRoleFamily[]
  /** v1.18.0: `hide_entry_level` hides intern, junior, graduate and entry-level titles. */
  readonly seniorityFloor: SeniorityFloor
  /** Read-only; increments on every successful save. */
  readonly version: number
}

/** What a save sends: the whole section, never a partial update (AC 1.4). */
export type JobCriteriaInput = Omit<JobCriteria, "version">

export type JobCriteriaListName = "frameworks" | "technologies"

/** The technology criterion is on when either list has an entry (AC 3.6). */
export function isTechnologyCriterionOn(criteria: Pick<JobCriteria, "frameworks" | "technologies">): boolean {
  return criteria.frameworks.length + criteria.technologies.length > 0
}
