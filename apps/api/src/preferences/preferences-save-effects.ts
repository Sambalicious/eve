import { Injectable } from "@nestjs/common"
import type { PreferencesValues } from "@eve/contracts"

import { sql } from "../db/sql.js"
import type { CandidateTx } from "../db/tenant-database.js"
import { type RedecideRow, redecideForSave } from "./redecide.js"

export type SavedVersion = Readonly<{
  candidateId: string
  /** The version this save wrote. */
  version: number
  /** The values it replaced; null for the first save (version 1). */
  previous: PreferencesValues | null
  values: PreferencesValues
}>

/**
 * What a save does besides storing the record (architecture.r6 "Save and
 * re-decision" steps 3 to 5, B1: steps 2 and 3 only). It runs inside the
 * save's transaction, after `job_preferences_version` V and `job_preferences`
 * are written and while the head row is held FOR UPDATE, so a failure here
 * rolls the save back too (R6-AC11).
 *
 * Only a change to the keyword or the family tiers can re-decide a stored
 * posting: Eligibility fields re-decide nothing stored (D21, r4 AC 4.23).
 * No Application row, AI call, fetch, spend entry or email: queued
 * Applications are dropped at their next claim (R6-4), never here.
 * Unit 7 adds the lock order; `job_preferences` FOR UPDATE is already the first
 * lock this transaction takes, before any `candidate_posting` row.
 */
@Injectable()
export class PreferencesSaveEffects {
  async afterSave(trx: CandidateTx, saved: SavedVersion): Promise<void> {
    if (!changesSteps2And3(saved.previous, saved.values)) return
    const rows = await redecidableRows(trx, saved.candidateId)
    const changed = redecideForSave(rows, saved.values)
    if (changed.length === 0) return
    // Only changed rows, and only while they still hold what this save read (the record lock keeps them so in B1).
    await sql`
      update candidate_posting cp
      set status = c.status, skip_reason = c.reason, skip_detail = null, preferences_version = ${saved.version}
      from unnest(${changed.map((row) => row.id)}::uuid[], ${changed.map((row) => row.status)}::text[], ${changed.map((row) => row.skipReason)}::text[],
                  ${changed.map((row) => row.previousStatus)}::text[], ${changed.map((row) => row.previousReason)}::text[])
        as c(id, status, reason, old_status, old_reason)
      where cp.candidate_id = ${saved.candidateId}::uuid and cp.job_posting_id = c.id
        and cp.status = c.old_status and cp.skip_reason is not distinct from c.old_reason`.execute(trx)
  }
}

/** True when the keyword or a family tier differs from the previous version. A first save (no previous) counts as a change. */
export function changesSteps2And3(previous: PreferencesValues | null, values: PreferencesValues): boolean {
  if (previous === null) return true
  if (previous.titleKeyword !== values.titleKeyword) return true
  return Object.keys(values.roleFamilyTiers).some((family) => previous.roleFamilyTiers[family as keyof typeof values.roleFamilyTiers] !== values.roleFamilyTiers[family as keyof typeof values.roleFamilyTiers])
}

/**
 * Step 3: this Candidate's ranked, skipped and excluded rows, except pre-filter
 * skips and `unsupported_application_system` (stored at first store, never
 * evaluated). `waiting_to_be_checked`, `checking`, `evaluation_failed` and
 * `not_checked` are never read. One indexed scan of one Candidate's postings.
 */
async function redecidableRows(trx: CandidateTx, candidateId: string): Promise<RedecideRow[]> {
  const { rows } = await sql<{ id: string; status: string; skip_reason: string | null; role_family: string | null; title_folded: string | null }>`
    select p.id, cp.status, cp.skip_reason, p.role_family, p.title_folded
    from candidate_posting cp
    join job_posting p on p.id = cp.job_posting_id
    where cp.candidate_id = ${candidateId}::uuid
      and cp.status in ('ranked', 'skipped', 'excluded')
      and p.prefilter_skip is null
      and cp.skip_reason is distinct from 'unsupported_application_system'`.execute(trx)
  return rows.map((row) => ({ id: row.id, status: row.status, skipReason: row.skip_reason, roleFamily: row.role_family, titleFolded: row.title_folded }))
}
