import { type Kysely, sql } from "kysely"

/**
 * Slice 7: cost ceiling, pauses, manual deletion and manual Outcomes
 * (architecture r1 "Cost metering": append-only ledger, reserve-then-settle,
 * serialized on a per-month row lock; prd.r4.md AC 10.1 to 10.5, AC 8).
 *
 * Money is stored in integer micro-USD (1 USD = 1,000,000), so sums are exact.
 *
 * - `spend_month`: one row per WAT calendar month. Every reservation locks it
 *   (FOR UPDATE), so two concurrent paid actions cannot jointly cross the
 *   ceiling. `ceiling_micros` is the month's ceiling (the configured default,
 *   or a Candidate raise for this month only, at most USD 100.00).
 * - `spend_entry`: one row per paid action. `reserved` before the action,
 *   `settled` with the actual cost after it, `released` when it never started.
 *   Rows are never deleted. Form-agent rows carry `sub_budget = 'form_agent'`
 *   and their attempt, for the per-attempt and monthly caps.
 * - `control_state` gains the cost-pause bookkeeping (when, which month, the
 *   refused action and its estimate, and when it last cleared on its own).
 * - `notification_outbox` gains kind `cost_pause` with its facts in `payload`.
 *   One row is written when the pause starts, so there is one email per pause.
 * - `outcome`: manual Outcomes (AC 8). `excerpt` is kept for post-MVP Gmail
 *   Outcomes; editing the type never touches it (OQ-D15).
 * - `application.details_deleted_at`: AC 10.3. The row itself stays as the
 *   minimal requisition record and keeps blocking duplicates until cleared.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("spend_month")
    .addColumn("month", "date", (c) => c.primaryKey().check(sql`extract(day from month) = 1`))
    .addColumn("ceiling_micros", "bigint", (c) => c.notNull().check(sql`ceiling_micros > 0 and ceiling_micros <= 100000000`))
    .addColumn("raised_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .execute()

  await db.schema
    .createTable("spend_entry")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("month", "date", (c) => c.notNull().references("spend_month.month"))
    .addColumn("category", "text", (c) => c.notNull().check(sql`category in ('hosting', 'ai', 'browser', 'discovery', 'email')`))
    .addColumn("sub_budget", "text", (c) => c.check(sql`sub_budget is null or sub_budget = 'form_agent'`))
    .addColumn("purpose", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().check(sql`status in ('reserved', 'settled', 'released')`))
    .addColumn("reserved_micros", "bigint", (c) => c.notNull().check(sql`reserved_micros >= 0`))
    .addColumn("actual_micros", "bigint", (c) => c.check(sql`actual_micros is null or actual_micros >= 0`))
    .addColumn("application_id", "uuid", (c) => c.references("application.id").onDelete("set null"))
    .addColumn("attempt_id", "uuid")
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("settled_at", "timestamptz")
    .addCheckConstraint("spend_entry_settled_has_actual", sql`(status = 'settled') = (actual_micros is not null)`)
    .execute()
  await sql`create index spend_entry_month_idx on spend_entry (month, category)`.execute(db)
  await sql`create index spend_entry_attempt_idx on spend_entry (attempt_id) where attempt_id is not null`.execute(db)
  // Hosting accrues once per month (architecture r1: "Hosting accrues on the 1st").
  await sql`create unique index spend_entry_hosting_once on spend_entry (month) where category = 'hosting'`.execute(db)

  await sql`alter table control_state
    add column cost_paused_at timestamptz,
    add column cost_paused_month date,
    add column cost_pause_action text,
    add column cost_pause_estimate_micros bigint,
    add column cost_pause_cleared_at timestamptz,
    add column global_paused_at timestamptz`.execute(db)

  await sql`alter table notification_outbox drop constraint notification_outbox_kind_check`.execute(db)
  await sql`alter table notification_outbox
    add constraint notification_outbox_kind_check check (kind in ('confirmed', 'blocked', 'uncertain', 'daily_summary', 'cost_pause')),
    add column payload jsonb,
    add constraint notification_outbox_cost_pause_payload check ((kind = 'cost_pause') = (payload is not null))`.execute(db)

  await db.schema
    .createTable("outcome")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("application_id", "uuid", (c) => c.notNull().references("application.id").onDelete("cascade"))
    .addColumn("type", "text", (c) => c.notNull().check(sql`type in ('confirmation', 'rejection', 'interview_invitation', 'request_for_action')`))
    .addColumn("source", "text", (c) => c.notNull().defaultTo("candidate").check(sql`source in ('candidate')`))
    .addColumn("excerpt", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute()
  await sql`create index outcome_application_idx on outcome (application_id, created_at)`.execute(db)

  // `final_status` is captured at deletion, because the Outcomes it may come from are deleted with the details.
  await sql`alter table application
    add column details_deleted_at timestamptz,
    add column final_status text,
    add constraint application_deleted_has_final_status check ((details_deleted_at is null) = (final_status is null))`.execute(db)
}
