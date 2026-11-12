import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0006 PRD r4, stuck `checking` recovery (architecture-stuck-checking.md,
 * Open question 22; AC-7.11, AC-7.12). Numbered 0032: the next free number
 * after 0031-pasted-description (D19: no number is reserved, merge order decides).
 *
 * - `candidate_posting.checking_since`: the last time the row moved into
 *   `checking`. Read only together with `status = 'checking'`; the app writes it
 *   on every move into `checking` and never clears it.
 * - Existing rows take the migration's `now()` through the column default (a
 *   fast default, no table rewrite, no RLS: DDL). A row already `checking` at
 *   ship therefore becomes stuck 15 minutes after ship, if no evaluation holds
 *   its lock (AC-7.12). No status changes, no job is queued, no model call.
 *
 * Additive, so the previous image can still insert rows (the default fills
 * the column). The `candidate_posting_candidate` RLS policy and the table
 * grants cover the column. Frozen and pure SQL: imports nothing from the app.
 */
export const STUCK_CHECKING_MARKER = "0032-stuck-checking"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table candidate_posting add column checking_since timestamptz not null default now()`.execute(db)
  await recordSchemaMarker(db, STUCK_CHECKING_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${STUCK_CHECKING_MARKER}`.execute(db)
  await sql`alter table candidate_posting drop column checking_since`.execute(db)
}
