import { type Kysely, sql } from "kysely"

/**
 * EPIC-0001 automatic 12-month expiry (architecture-12-month-expiry.md
 * "Migration", PRD E6.1, E6.2, D-E14). Numbered after main's `0013-stack-posts`.
 *
 * - `application.details_deleted_by`: who deleted the detailed records. Rows
 *   deleted before this migration are backfilled as 'candidate'. No pairing
 *   constraint with `details_deleted_at`: an older api still writing during a
 *   rollout or rollback leaves it null, and readers map null to 'candidate'.
 * - `retention_run`: one row per run of `retention.daily`, counts only. No
 *   company, role, URL, requisition ID or Application id (E6.2).
 * - `application_live_created_idx`: the job's selection and the retention counts
 *   read live rows by `created_at`.
 * - `submission_event_application_idx`: deletion by `application_id` had no
 *   index on this table (architecture "Statement timeout"). `application_form_read`
 *   is keyed by `application_id`, so it needs none.
 *
 * Pure SQL, no imports from app code: migrations are history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table application add column details_deleted_by text
    check (details_deleted_by in ('candidate', 'expiry'))`.execute(db)
  await sql`update application set details_deleted_by = 'candidate' where details_deleted_at is not null`.execute(db)

  await sql`create table retention_run (
    id uuid primary key,
    wat_date date not null,
    started_at timestamptz not null,
    finished_at timestamptz,
    outcome text not null check (outcome in ('running', 'completed', 'skipped_global_paused', 'skipped_launch_grace', 'failed')),
    due_count integer not null default 0 check (due_count >= 0),
    deleted_count integer not null default 0 check (deleted_count >= 0),
    skipped_in_flight integer not null default 0 check (skipped_in_flight >= 0),
    skipped_pending_decision integer not null default 0 check (skipped_pending_decision >= 0),
    skipped_locked integer not null default 0 check (skipped_locked >= 0),
    failed_count integer not null default 0 check (failed_count >= 0),
    files_released integer not null default 0 check (files_released >= 0)
  )`.execute(db)
  await sql`create index retention_run_wat_date_idx on retention_run (wat_date desc, started_at desc)`.execute(db)
  await sql`create index application_live_created_idx on application (created_at) where details_deleted_at is null`.execute(db)
  await sql`create index submission_event_application_idx on submission_event (application_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index submission_event_application_idx`.execute(db)
  await sql`drop index application_live_created_idx`.execute(db)
  await sql`drop table retention_run`.execute(db)
  await sql`alter table application drop column details_deleted_by`.execute(db)
}
