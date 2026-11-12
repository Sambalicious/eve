import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0008 (api-contract.md v1.22.0 "Migration", architecture AR-1, AR-2,
 * AR-5). Numbered 0024: EPIC-0002 A2's 0022 and 0023 merged first (D19).
 * Each Candidate's own Stack posts permitted-use record:
 *
 * - `alert_feed_candidate_verification`: one row at most per Candidate, keyed
 *   by `candidate_id`, column for column the same as `hiring_feed_verification`
 *   (0021). Forced RLS and one `<table>_candidate` policy whose text is the one
 *   A2's 0022-candidate-binding gives every Candidate policy (`stack_post`,
 *   `hiring_feed_verification`): the transaction's bound Candidate AND
 *   `eve.candidate_id`. Grants come from migrate-and-grant.
 * - OD-1, OD-2: the legacy shared `alert_feed_verification` row is copied into
 *   the Operator's own row, in-database (byte-identical values), only when
 *   exactly one Operator and exactly one legacy row exist. No invitee gets a
 *   copy. The Operator's identity state is not checked (GH-3). FORCE RLS binds
 *   this owner role too, so the copy sets `eve.candidate_id` to the Operator
 *   and binds the transaction to the Operator (`bind_candidate`, which the
 *   owner may execute), then clears the setting, which hides the rows again.
 *
 * The legacy table is left as it is (rows and grants, AR-5): rollback path A
 * needs the previous image to keep reading it. Nothing is deleted (AC 5.4).
 *
 * Frozen and pure SQL: imports nothing from the app. `down` drops only the new
 * table (development only) and never touches `alert_feed_verification`.
 */
export const ALERT_FEED_CANDIDATE_VERIFICATION_MARKER = "0024-alert-feed-candidate-verification"

/** Candidate data: deletion cascades from `candidate`. */
export const STACK_FEED_VERIFICATION_TABLES = ["alert_feed_candidate_verification"] as const

/** Copied from 0022-candidate-binding: the policy every Candidate table has after it. */
const BOUND_CANDIDATE = sql.raw("(select public.bound_candidate())")
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table alert_feed_candidate_verification (
    candidate_id uuid primary key references candidate(id) on delete cascade,
    verified_on date not null,
    verification_basis text not null check (char_length(verification_basis) between 1 and 500),
    updated_at timestamptz not null
  )`.execute(db)
  for (const table of STACK_FEED_VERIFICATION_TABLES) {
    const t = sql.table(table)
    await sql`alter table ${t} enable row level security`.execute(db)
    await sql`alter table ${t} force row level security`.execute(db)
    const admitted = sql`candidate_id = ${BOUND_CANDIDATE} and candidate_id = ${CURRENT_CANDIDATE}`
    await sql`create policy ${sql.id(`${table}_candidate`)} on ${t} for all using (${admitted}) with check (${admitted})`.execute(db)
  }

  const operators = await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(db)
  const legacy = await sql<{ n: number }>`select count(*)::int as n from alert_feed_verification`.execute(db)
  const operatorId = operators.rows.length === 1 ? operators.rows[0]!.id : null
  if (operatorId !== null && legacy.rows[0]?.n === 1) {
    await sql`select set_config('eve.candidate_id', ${operatorId}, true), public.bind_candidate(${operatorId}::uuid)`.execute(db)
    await sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at)
      select ${operatorId}::uuid, verified_on, verification_basis, updated_at from alert_feed_verification`.execute(db)
    await sql`select set_config('eve.candidate_id', '', true)`.execute(db)
  }

  await recordSchemaMarker(db, ALERT_FEED_CANDIDATE_VERIFICATION_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${ALERT_FEED_CANDIDATE_VERIFICATION_MARKER}`.execute(db)
  for (const table of [...STACK_FEED_VERIFICATION_TABLES].reverse()) await sql`drop table ${sql.table(table)}`.execute(db)
}
