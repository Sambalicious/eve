import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * Apply anyway: the Candidate can turn a skipped or excluded Job Posting into an
 * Application, and the assistant may submit it. Numbered 0025: it merged after
 * EPIC-0008's 0024 (D19: no number is reserved, merge order decides).
 *
 * - `application.candidate_override_at`: set when the Application was created
 *   from a posting that was not ranked for its Candidate at that moment. The
 *   submission checks (claim, pre-attempt drop, point of no return) accept a
 *   skipped or excluded posting for these Applications instead of dropping them
 *   as no longer ranked. Null for every existing row, so existing behaviour is
 *   unchanged.
 *
 * Additive and nullable, so the previous image can still write Applications.
 * The existing table grants and RLS policy on `application` cover the column.
 * Frozen and pure SQL: imports nothing from the app.
 */
export const APPLY_ANYWAY_MARKER = "0025-apply-anyway"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table application add column candidate_override_at timestamptz`.execute(db)
  await recordSchemaMarker(db, APPLY_ANYWAY_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${APPLY_ANYWAY_MARKER}`.execute(db)
  await sql`alter table application drop column candidate_override_at`.execute(db)
}
