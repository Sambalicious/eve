import type { ApplicationOverride } from "@eve/contracts"

import type { CandidateTx } from "../db/tenant-database.js"
import { visibilityFactsOf } from "../discovery/discovery.repository.js"
import { type VisibilityContext, hiddenReason, visibilityContext } from "../discovery/visibility.js"
import { type OverrideColumns, type PostingDecisionState, applicationOverride, decisionOf } from "./override.js"

/**
 * v1.24.0: the session Candidate's current decision and visibility for each
 * posting, in one query (`candidate_posting`, `job_posting` visibility facts,
 * `eligibility_result` rules), so lists don't pay one query per row. A posting
 * the Candidate doesn't hold has no entry.
 */
export async function postingStates(tx: CandidateTx, candidateId: string, postingIds: readonly string[], ctx: VisibilityContext): Promise<Map<string, PostingDecisionState>> {
  const ids = [...new Set(postingIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom("candidate_posting as cp")
    .innerJoin("job_posting as p", "p.id", "cp.job_posting_id")
    .leftJoin("eligibility_result as e", (join) => join.onRef("e.job_posting_id", "=", "cp.job_posting_id").on("e.candidate_id", "=", candidateId))
    .select(["cp.job_posting_id", "cp.status", "cp.skip_reason", "cp.skip_detail", "cp.evaluation_failure", "e.rules", "p.title_folded", "p.prefilter_skip", "p.role_family", "p.seniority_marker", "p.posted_at", "p.origin"])
    .where("cp.candidate_id", "=", candidateId)
    .where("cp.job_posting_id", "in", ids)
    .execute()
  return new Map(
    rows.map((row) => [
      row.job_posting_id,
      {
        decision: decisionOf(row, row.rules),
        hidden: hiddenReason(visibilityFactsOf(row), ctx) !== null,
        evaluationFailure: row.evaluation_failure,
        pastedDescription: row.origin === "pasted_description",
      },
    ])
  )
}

/** The posting state of one posting, with the visibility context read in `tx` (FOR SHARE when `lock` is set). */
export async function postingState(tx: CandidateTx, candidateId: string, postingId: string, now: Date, lock?: "share"): Promise<PostingDecisionState | null> {
  const ctx = await visibilityContext(tx, candidateId, now, lock)
  return (await postingStates(tx, candidateId, [postingId], ctx)).get(postingId) ?? null
}

/**
 * v1.27.0 (PD-4.1): the ids of these postings whose apply mode is `manual` (never queued, sampled or
 * submitted). A posting the Candidate can no longer see is left out.
 */
export async function manualPostingIds(tx: CandidateTx, postingIds: readonly string[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(postingIds)]
  if (ids.length === 0) return new Set()
  const rows = await tx.selectFrom("job_posting").select("id").where("id", "in", ids).where("apply_mode", "=", "manual").execute()
  return new Set(rows.map((row) => row.id))
}

/** `override` for each Application row, by id, computed from one posting-state read. */
export async function overridesFor(
  tx: CandidateTx,
  candidateId: string,
  rows: readonly (OverrideColumns & Readonly<{ id: string; job_posting_id: string }>)[],
  now: Date
): Promise<Map<string, ApplicationOverride | null>> {
  const recorded = rows.filter((row) => row.details_deleted_at === null && (row.override_created_at !== null || row.candidate_override_at !== null))
  const states = recorded.length === 0 ? new Map<string, PostingDecisionState>() : await postingStates(tx, candidateId, recorded.map((row) => row.job_posting_id), await visibilityContext(tx, candidateId, now))
  return new Map(rows.map((row) => [row.id, applicationOverride(row, states.get(row.job_posting_id) ?? null)]))
}
