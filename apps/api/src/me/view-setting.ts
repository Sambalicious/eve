import type { CandidateTx } from "../db/tenant-database.js"
import { sql } from "../db/sql.js"

/**
 * EPIC-0011 (migration 0033): `candidate_view_setting`, one row per Candidate.
 * A missing row reads as the defaults. Lock order for every writer of
 * `advanced_enabled` or `activation_state.automatic_enabled` (architecture D4):
 * `activation_state` row FOR UPDATE first, then this row (upsert).
 */
export interface ViewState {
  advancedEnabled: boolean
  advancedLocked: boolean
  simplerNoteDue: boolean
  improveListDismissed: boolean
}

/** Step 1 of the lock order. An absent row means automatic is off. Returns `automatic_enabled`. */
export async function lockActivation(tx: CandidateTx, candidateId: string): Promise<boolean> {
  const row = await tx.selectFrom("activation_state").select("automatic_enabled").where("candidate_id", "=", candidateId).forUpdate().executeTakeFirst()
  return row?.automatic_enabled ?? false
}

/** Step 2: the Advanced flag. Other columns are never changed; a new row takes their defaults. */
export async function upsertAdvanced(tx: CandidateTx, candidateId: string, enabled: boolean, now: Date): Promise<void> {
  await tx
    .insertInto("candidate_view_setting")
    .values({ candidate_id: candidateId, advanced_enabled: enabled, updated_at: now })
    .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ advanced_enabled: enabled, updated_at: now }))
    .execute()
}

export async function dismissSimplerNote(tx: CandidateTx, candidateId: string, now: Date): Promise<void> {
  await tx
    .insertInto("candidate_view_setting")
    .values({ candidate_id: candidateId, simpler_note_due: false, updated_at: now })
    .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ simpler_note_due: false, updated_at: now }))
    .execute()
}

/** The first dismissal time is kept. */
export async function dismissImproveList(tx: CandidateTx, candidateId: string, now: Date): Promise<void> {
  await tx
    .insertInto("candidate_view_setting")
    .values({ candidate_id: candidateId, improve_list_dismissed_at: now, updated_at: now })
    .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ improve_list_dismissed_at: sql<Date>`coalesce(candidate_view_setting.improve_list_dismissed_at, ${now})`, updated_at: now }))
    .execute()
}

export async function readViewState(tx: CandidateTx, candidateId: string): Promise<ViewState> {
  const setting = await tx.selectFrom("candidate_view_setting").selectAll().where("candidate_id", "=", candidateId).executeTakeFirst()
  const activation = await tx.selectFrom("activation_state").select("automatic_enabled").where("candidate_id", "=", candidateId).executeTakeFirst()
  return {
    advancedEnabled: setting?.advanced_enabled ?? false,
    advancedLocked: activation?.automatic_enabled ?? false,
    simplerNoteDue: setting?.simpler_note_due ?? false,
    improveListDismissed: (setting?.improve_list_dismissed_at ?? null) !== null,
  }
}
