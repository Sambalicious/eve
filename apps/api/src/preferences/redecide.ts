import { type PreferenceSkipInput, type PreferenceSkipReason, decidePreferenceSkip } from "../discovery/rules/preference-rules.js"

/**
 * EPIC-0002 B1 (architecture.r6 "Save and re-decision" step 4, R6-2): the pure
 * re-decision a Job Preferences save runs over the Candidate's stored
 * decisions. B1 builds steps 2 and 3 only (family, then keyword); B2 adds the
 * Match and technology steps (7 and 8) here and deletes `job-criteria/redecide.ts`.
 * One implementation: the evaluator, this save and (unit 7) the Job criteria
 * save all decide steps 2 and 3 with `stepsTwoAndThree`.
 */

/** One stored decision the save may change: ranked, skipped or excluded, never a pre-filter skip (the repository filters those). */
export type RedecideRow = Readonly<{
  id: string
  status: string
  skipReason: string | null
  roleFamily: string | null
  titleFolded: string | null
}>

export type RedecidedRow = Readonly<{
  id: string
  status: "skipped" | "waiting_to_be_checked"
  skipReason: PreferenceSkipReason | null
  /** What the save read, so the write can refuse to overwrite a newer decision (unit 7 guard). */
  previousStatus: string
  previousReason: string | null
}>

const PREFERENCE_REASONS: ReadonlySet<string> = new Set<PreferenceSkipReason>(["excluded_role_family", "keyword_mismatch"])

/** R6-2 steps 2 then 3 under `preferences`: the skip reason, or null when both pass. */
export function stepsTwoAndThree(preferences: PreferenceSkipInput, posting: Readonly<{ roleFamily: string | null; titleFolded: string | null }>): PreferenceSkipReason | null {
  return decidePreferenceSkip(preferences, posting)
}

/**
 * For each row: fails step 2 or 3 → `skipped` with that reason (any status,
 * `excluded` included); was skipped by step 2 or 3 and now passes both →
 * `waiting_to_be_checked` with no reason; anything else keeps its row.
 * Returns only rows whose status or reason changes.
 */
export function redecideForSave(rows: readonly RedecideRow[], preferences: PreferenceSkipInput): RedecidedRow[] {
  const changed: RedecidedRow[] = []
  for (const row of rows) {
    const reason = stepsTwoAndThree(preferences, row)
    const wasPreferenceSkip = row.status === "skipped" && row.skipReason !== null && PREFERENCE_REASONS.has(row.skipReason)
    const next: Pick<RedecidedRow, "status" | "skipReason"> | null =
      reason !== null ? { status: "skipped", skipReason: reason } : wasPreferenceSkip ? { status: "waiting_to_be_checked", skipReason: null } : null
    if (next === null || (next.status === row.status && next.skipReason === row.skipReason)) continue
    changed.push({ id: row.id, ...next, previousStatus: row.status, previousReason: row.skipReason })
  }
  return changed
}
