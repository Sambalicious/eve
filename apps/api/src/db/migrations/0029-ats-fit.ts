import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * ATS ranking (owner decision 2026-11-01). `match_evidence.ats_fit`: the share (0 to 100) of the
 * posting's ATS requirements the Candidate's approved Career Profile meets, written with the rest of
 * the Match evidence at evaluation. Null for evidence written before; the Ranked tab sorts those last
 * within their tier. The column sits on a table with its forced `<table>_candidate` policy already,
 * so it needs no policy or grant of its own.
 *
 * Frozen: imports nothing from the app or `@eve/contracts`.
 */
export const ATS_FIT_MARKER = "0029-ats-fit"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table match_evidence add column ats_fit smallint`.execute(db)
  await sql`alter table match_evidence add constraint match_evidence_ats_fit_check check (ats_fit is null or (ats_fit between 0 and 100))`.execute(db)
  await recordSchemaMarker(db, ATS_FIT_MARKER)
}

/** Reverts 0029: drops the column with its check and removes the marker. Postings refill it when evaluated again. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${ATS_FIT_MARKER}`.execute(db)
  await sql`alter table match_evidence drop constraint if exists match_evidence_ats_fit_check`.execute(db)
  await sql`alter table match_evidence drop column if exists ats_fit`.execute(db)
}
