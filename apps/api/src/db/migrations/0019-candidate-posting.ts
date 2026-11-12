import { type Kysely, sql } from "kysely"
import type { Migration } from "kysely/migration"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0002 A1 item 6 (architecture r2 "Shared posting split"; r4 step 5).
 * Numbered 0019: 0018 is the owner's Job Preferences.
 *
 * `job_posting` keeps the shared facts of a posting. What one Candidate decided
 * about it moves to `candidate_posting`, one row per (Candidate, posting):
 * origin, status, skip reason and detail, evaluation failure, discovered and
 * evaluated times. Before this split a second Candidate's evaluation overwrote
 * the first's status (last writer wins).
 *
 * 1. `candidate_posting`, backfilled for the owner (the Operator) from every
 *    `job_posting` row, values copied as they are.
 * 2. (r4) `job_posting.prefilter_skip`: the slice 8 pre-filter's skip is a
 *    posting fact. Backfilled from rows skipped as `not_software_role`; the
 *    owner's copied row keeps its status and reason, so the Skipped tab is
 *    unchanged.
 * 3. `eligibility_result` and `match_evidence` reference the Candidate's
 *    `candidate_posting` row (r2 "re-key to it"); their primary key is already
 *    `(candidate_id, job_posting_id)` from 0016. Deleting a Candidate's row
 *    deletes their evaluation with it.
 * 4. `candidate_posting.job_posting_id` is ON DELETE RESTRICT: a shared posting
 *    can only be deleted once no Candidate holds it. Foreign key checks ignore
 *    RLS, so this also covers rows the deleting Candidate cannot see.
 * 5. Indexes from 0011 with a leading `candidate_id`, then forced RLS and
 *    `candidate_posting_candidate`, as 0017 does for every Candidate table.
 *    Indexes and RLS come last on purpose: a failure there rolls back the
 *    backfill too (the migration test relies on it).
 *
 * The five old `job_posting` columns (status, skip_reason, skip_detail,
 * evaluation_failure, evaluated_at) stay, nullable and no longer written, for
 * one release; a later migration drops them with `job_posting_status_idx` and
 * `job_posting_status_newest_idx`, as EPIC-0004 did with its retired threshold column.
 */
export const CANDIDATE_POSTING_TABLES: readonly string[] = ["candidate_posting"]

const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

export const up: Migration["up"] = async (db: Kysely<unknown>) => {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  await run(sql`create table candidate_posting (
    candidate_id uuid not null references candidate (id) on delete cascade,
    job_posting_id uuid not null references job_posting (id) on delete restrict,
    origin text not null check (origin in ('employer_board', 'remote_board', 'pasted_link')),
    status text not null check (status in ('checking', 'waiting_to_be_checked', 'ranked', 'excluded', 'skipped', 'evaluation_failed')),
    skip_reason text,
    skip_detail text,
    evaluation_failure text,
    discovered_at timestamptz not null,
    evaluated_at timestamptz,
    primary key (candidate_id, job_posting_id)
  )`)

  const postings = await sql<{ n: number }>`select count(*)::int as n from job_posting`.execute(db)
  if ((postings.rows[0]?.n ?? 0) > 0) {
    const operator = await sql<{ id: string }>`select id from candidate where role = 'operator'`.execute(db)
    const ownerId = operator.rows[0]?.id
    if (ownerId === undefined) throw new Error("No Operator: migration 0016 must run first")
    await run(sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
      select ${ownerId}::uuid, id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at from job_posting`)
  }

  await run(sql`alter table job_posting add column prefilter_skip text check (prefilter_skip in ('not_software_role'))`)
  await run(sql`update job_posting set prefilter_skip = 'not_software_role' where status = 'skipped' and skip_reason = 'not_software_role'`)
  await run(sql`alter table job_posting alter column status drop not null`)

  for (const table of ["eligibility_result", "match_evidence"]) {
    await run(sql`alter table ${sql.table(table)} add constraint ${sql.id(`${table}_candidate_posting_fk`)}
      foreign key (candidate_id, job_posting_id) references candidate_posting (candidate_id, job_posting_id) on delete cascade`)
  }

  await run(sql`create index candidate_posting_job_posting_idx on candidate_posting (job_posting_id)`)
  await run(sql`create index candidate_posting_newest_idx on candidate_posting (candidate_id, discovered_at desc, job_posting_id)`)
  await run(sql`create index candidate_posting_status_newest_idx on candidate_posting (candidate_id, status, discovered_at desc, job_posting_id)`)

  await run(sql`alter table candidate_posting enable row level security`)
  await run(sql`alter table candidate_posting force row level security`)
  await run(sql`create policy candidate_posting_candidate on candidate_posting for all
    using (candidate_id = ${CURRENT_CANDIDATE}) with check (candidate_id = ${CURRENT_CANDIDATE})`)
  await recordSchemaMarker(db, "0019-candidate-posting")
}
