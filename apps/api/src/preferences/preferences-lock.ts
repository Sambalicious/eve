import type { CandidateTx } from "../db/tenant-database.js"
import { type PreferencesSnapshot, readPreferences } from "./preferences-read.js"

/**
 * EPIC-0002 B1 lock order (architecture.r6 "Lock order and SEC-014"): step 1,
 * the Candidate's `job_preferences` row FOR SHARE, before `job_criteria`
 * (FOR SHARE in claims, the evaluator, samples and Check again; FOR UPDATE in
 * the Job criteria save), any `application` or `candidate_posting` row. The
 * preferences save holds this row FOR UPDATE and takes no `job_criteria`
 * lock, so no cycle exists. B2 removes the `job_criteria` locks.
 *
 * Returns the current version (null with no record: an invitee before step 3
 * has no queued Application, no criteria save on postings, nothing ranked).
 * A stored value that no longer parses throws, so the caller fails closed.
 */
export function sharePreferences(trx: CandidateTx, candidateId: string): Promise<PreferencesSnapshot | null> {
  return readPreferences(trx, candidateId, "share")
}
