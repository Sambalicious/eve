import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.28.1 fix, after 0036 (migration discipline: an applied migration is never edited).
 *
 * 0036 stamped existing failed rows with `evaluation_attempts = 1`, but
 * `candidate_posting` has FORCE row-level security and the migration runs as the
 * owner role, which is bound to no Candidate — so the UPDATE matched zero rows and
 * every pre-existing failure still reads 0. That would let the worker retry those
 * rows twice instead of once.
 *
 * The same `no force row level security` step 0026 already uses for its legacy
 * move: lift FORCE for the one statement and restore it in the same transaction.
 * Idempotent: rows that already carry 1 are left alone.
 */
export const RETRY_BACKFILL_MARKER = "0037-retry-backfill"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table candidate_posting no force row level security`.execute(db)
  await sql`update candidate_posting set evaluation_attempts = 1 where status = 'evaluation_failed' and evaluation_attempts = 0`.execute(db)
  await sql`alter table candidate_posting force row level security`.execute(db)
  await recordSchemaMarker(db, RETRY_BACKFILL_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${RETRY_BACKFILL_MARKER}`.execute(db)
}
