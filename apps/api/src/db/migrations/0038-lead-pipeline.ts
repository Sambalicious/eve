import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.29.0 lead pipeline (owner decision 2026-11-10). A lead is the Candidate's
 * own progression through a posting they already have: Saved, Applied,
 * Interviewing, Offer or Rejected. It is deliberately separate from
 * `application` (Eve's documents and submissions) and from `candidate_posting`
 * (the verdict), so a job Eve cannot submit for — the manual lane — can still be
 * tracked the same way.
 *
 * - One row per Candidate and posting, keyed to `candidate_posting`, so a lead
 *   disappears with the posting row and can never point at a posting the
 *   Candidate does not hold.
 * - Forced RLS with the 0017 Candidate policy, like every other Candidate table.
 *   Grants come from `migrate-and-grant` on the next migrate step.
 * - Additive and empty: no backfill, because no Candidate has a stage yet.
 *   `down` is development only.
 */
export const LEAD_PIPELINE_MARKER = "0038-lead-pipeline"

export const LEAD_TABLES = ["lead"] as const

/** Copied from 0017 (`stack_post_candidate`). */
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  await run(sql`create table lead (
    candidate_id uuid not null references candidate(id) on delete cascade,
    job_posting_id uuid not null,
    stage text not null check (stage in ('saved', 'applied', 'interviewing', 'offer', 'rejected')),
    stage_changed_at timestamptz not null,
    created_at timestamptz not null,
    primary key (candidate_id, job_posting_id),
    constraint lead_candidate_posting_fk foreign key (candidate_id, job_posting_id)
      references candidate_posting (candidate_id, job_posting_id) on delete cascade
  )`)
  await run(sql`create index lead_stage_idx on lead (candidate_id, stage, stage_changed_at desc, job_posting_id)`)

  await run(sql`alter table lead enable row level security`)
  await run(sql`alter table lead force row level security`)
  await run(sql`create policy ${sql.id("lead_candidate")} on lead for all
    using (candidate_id = ${CURRENT_CANDIDATE}) with check (candidate_id = ${CURRENT_CANDIDATE})`)

  await recordSchemaMarker(db, LEAD_PIPELINE_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${LEAD_PIPELINE_MARKER}`.execute(db)
  await sql`drop table if exists lead`.execute(db)
}
