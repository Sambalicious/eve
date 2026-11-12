import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0012 rule 4 (design 2a, D2 = posting text only). Numbered 0034: the
 * next free number after 0033-simplify-eve (D19: merge order decides).
 *
 * - `job_posting.forward_statements`: up to 3 verified quotes about where the
 *   employer is heading, a JSON array of strings. Null when the posting has
 *   none and for every pasted description.
 * - Additive and DDL only: the previous image can still insert rows (the
 *   column is nullable), and the existing `job_posting` RLS policies and grants
 *   cover the column unchanged.
 *
 * Frozen and pure SQL: imports nothing from the app. `down` is development only.
 */
export const FORWARD_STATEMENTS_MARKER = "0034-forward-statements"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table job_posting add column forward_statements jsonb`.execute(db)
  await sql`alter table job_posting add constraint job_posting_forward_statements_check check (forward_statements is null or jsonb_typeof(forward_statements) = 'array')`.execute(db)
  await recordSchemaMarker(db, FORWARD_STATEMENTS_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${FORWARD_STATEMENTS_MARKER}`.execute(db)
  await sql`alter table job_posting drop constraint if exists job_posting_forward_statements_check`.execute(db)
  await sql`alter table job_posting drop column if exists forward_statements`.execute(db)
}
