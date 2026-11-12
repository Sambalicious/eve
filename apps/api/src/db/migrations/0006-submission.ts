import { type Kysely, sql } from "kysely"

/**
 * Slice 5: submission state machine, daily cap, existing applications,
 * Activation Gate, and the notification outbox (architecture r1 journey 2,
 * ADR 0005, ADR 0008).
 *
 * The submission state is a separate column from the slice 4 documents
 * `state`, so the documents contract is unchanged. `submitting` is committed
 * before the backend's single submit click; boot recovery turns
 * `submit_claimed` and `submitting` into `uncertain` and never re-queues them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table application
    add column submission_state text check (submission_state in
      ('queued', 'submit_claimed', 'submitting', 'confirmed', 'uncertain', 'blocked', 'manual', 'not_submitted', 'declined')),
    add column submission_kind text check (submission_kind in ('automatic', 'sample')),
    add column attempt_id uuid,
    add column attempt_number integer not null default 0,
    add column submit_clicked_at timestamptz,
    add column submitted_wat_day date,
    add column confirmed_at timestamptz,
    add column evidence_kind text check (evidence_kind in ('confirmation_page', 'application_id', 'marked_confirmed')),
    add column evidence_text text,
    add column captcha_after_submit boolean not null default false,
    add column blocked_reason text check (blocked_reason in
      ('missing_approved_answer', 'login', 'email_verification', 'captcha', 'assessment', 'same_company_review',
       'declaration', 'personal_data_request', 'automation_incomplete')),
    add column blocked_sub_reason text check (blocked_sub_reason in ('budget', 'redirect', 'submit_attempt', 'value_mismatch')),
    add column blocked_detail text,
    add column blocked_at timestamptz,
    add column cover_letter_status text not null default 'not_submitted' check (cover_letter_status in ('not_submitted', 'uploaded', 'no_field')),
    add column sample_state text check (sample_state in ('awaiting_review', 'approved', 'rejected')),
    add column sample_reject_reason text,
    add column sample_counts boolean not null default false,
    add column declined_reason text,
    add column manual_completed_at timestamptz,
    add column queued_for_wat_day date`.execute(db)
  await sql`alter table application add constraint application_submitting_has_click
    check (submission_state is distinct from 'submitting' or submit_clicked_at is not null)`.execute(db)
  // A Blocked Application has its reason. The reason stays for history after manual completion.
  await sql`alter table application add constraint application_blocked_has_reason
    check (submission_state is distinct from 'blocked' or blocked_reason is not null)`.execute(db)
  await sql`create index application_submission_state_idx on application (submission_state)`.execute(db)
  await sql`create index application_company_idx on application (lower(company))`.execute(db)

  // AC 6.1: at most 5 automatic submissions per WAT day. The claim locks this row (FOR UPDATE) and counts
  // that day's claimed, submitting and confirmed automatic Applications, so concurrent claims serialize.
  await db.schema
    .createTable("submission_day")
    .addColumn("wat_day", "date", (c) => c.primaryKey())
    .execute()

  // AC 1.6: applications made before the assistant, recorded at setup. They block duplicates.
  await db.schema
    .createTable("existing_application")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("company", "text", (c) => c.notNull())
    .addColumn("role_title", "text", (c) => c.notNull())
    .addColumn("application_url", "text", (c) => c.notNull())
    .addColumn("requisition_id", "text")
    .addColumn("applied_on", "date", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .execute()
  await sql`create unique index existing_application_key_idx on existing_application (application_url, coalesce(requisition_id, ''))`.execute(db)

  // AC 2: the gate passes once; automatic submission is enabled only after it.
  await db.schema
    .createTable("activation_state")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("existing_applications_completed_at", "timestamptz")
    .addColumn("gate_passed_at", "timestamptz")
    .addColumn("automatic_enabled", "boolean", (c) => c.notNull().defaultTo(false))
    .addCheckConstraint("activation_enabled_after_gate", sql`not automatic_enabled or gate_passed_at is not null`)
    .execute()
  await sql`insert into activation_state (singleton) values (true)`.execute(db)

  // Refused or logged submission events (pre-gate automatic attempt, cap refusals). Append-only by convention.
  await db.schema
    .createTable("submission_event")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("application_id", "uuid", (c) => c.references("application.id").onDelete("set null"))
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("detail", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .execute()

  // Notification outbox: written in the same transaction as the state change. The sender is slice 6.
  await db.schema
    .createTable("notification_outbox")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("application_id", "uuid", (c) => c.references("application.id").onDelete("cascade"))
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('confirmed', 'blocked', 'uncertain')`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("sent_at", "timestamptz")
    .execute()
}
