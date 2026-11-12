import { type DecisionCriteria, decideJobCriteria } from "../discovery/rules/job-criteria.js"

/** One ranked or skipped posting with Match evidence, as the save reads it: names only, never quotes or text. */
export type StoredDecision = Readonly<{
  id: string
  status: string
  skipReason: string | null
  verdict: string
  coveredCount: number
  totalCount: number
  /**
   * null = no technology data. Elements come from stored jsonb, so they are not
   * trusted to be strings: a malformed entry is ignored (SEC-008, AC 5.11).
   */
  technologyNames: readonly unknown[] | null
}>

export type ChangedDecision = Readonly<{
  id: string
  status: "ranked" | "skipped"
  skipReason: "weak_core_match" | "technology_mismatch" | null
  verdict: "strong" | "weak"
  weakReason: "coverage_below_threshold" | null
  previousStatus: string
}>

/** AC 5.4: only these outcomes come from steps 4 and 5, so only these are re-decided. */
export function isRedecidable(row: Pick<StoredDecision, "status" | "skipReason" | "totalCount">): boolean {
  if (row.totalCount === 0) return false
  return row.status === "ranked" || (row.status === "skipped" && (row.skipReason === "weak_core_match" || row.skipReason === "technology_mismatch"))
}

/**
 * AC 5.3, 5.4: re-decides steps 4 and 5 from stored evidence with the new
 * criteria and returns only the rows whose status, reason or Match verdict
 * changed. No AI, no fetch: counts and verified names only.
 */
export function redecide(rows: readonly StoredDecision[], criteria: DecisionCriteria): { considered: number; changed: ChangedDecision[] } {
  let considered = 0
  const changed: ChangedDecision[] = []
  for (const row of rows) {
    if (!isRedecidable(row)) continue
    considered += 1
    const decision = decideJobCriteria({ coveredCount: row.coveredCount, totalCount: row.totalCount, technologyNames: wellFormedNames(row.technologyNames) }, criteria)
    if (decision.status === row.status && decision.skipReason === row.skipReason && decision.match.verdict === row.verdict) continue
    changed.push({
      id: row.id,
      status: decision.status,
      skipReason: decision.skipReason,
      verdict: decision.match.verdict,
      weakReason: decision.match.weakReason === "coverage_below_threshold" ? "coverage_below_threshold" : null,
      previousStatus: row.status,
    })
  }
  return { considered, changed }
}

/**
 * SEC-008 (AC 5.11): keeps only string names. A malformed stored entry counts
 * as not mentioned; the other entries are matched as usual. A list of only
 * malformed entries is still technology data that mentions nothing, never
 * "not checked".
 */
export function wellFormedNames(names: readonly unknown[] | null): string[] | null {
  if (names === null) return null
  return names.filter((name): name is string => typeof name === "string")
}
