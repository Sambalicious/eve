import { type Kysely, sql } from "kysely"

/**
 * Slice 6: the outbox sender (architecture r1: transactional outbox, separate
 * sender with retries). Each row is claimed, sent and marked once; a failed
 * attempt is retried with backoff up to a maximum, then marked `failed`.
 * Only a short error code is stored, never server text or credentials (AC 7.7).
 * A row left `sending` by a crash is marked failed (`interrupted`), not resent,
 * so a send that may have gone out is never repeated.
 *
 * - `confirmed` is unique per Application, so a Confirmed Submission evidenced
 *   twice has one email (notifications.feature, duplicate).
 * - `uncertain` rows feed the daily summary and are never emailed alone:
 *   existing ones become `skipped`.
 * - `daily_summary` is unique per WAT day (AC 7.3).
 *
 * `notification_sender_state` is written by the worker at start: whether it has
 * Gmail SMTP settings. The api reads it, so the app password stays out of the
 * api process environment (AC 7.6).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table notification_outbox drop constraint notification_outbox_kind_check`.execute(db)
  await sql`alter table notification_outbox
    add constraint notification_outbox_kind_check check (kind in ('confirmed', 'blocked', 'uncertain', 'daily_summary')),
    add column wat_day date,
    add column status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
    add column attempts integer not null default 0,
    add column next_attempt_at timestamptz,
    add column claimed_at timestamptz,
    add column last_error text check (last_error is null or last_error in ('auth_failed', 'send_refused', 'timeout', 'connection_failed', 'interrupted', 'unknown')),
    add column last_failed_at timestamptz,
    add constraint notification_outbox_summary_day check ((kind = 'daily_summary') = (wat_day is not null))`.execute(db)
  await sql`update notification_outbox set status = case when kind = 'uncertain' then 'skipped' when sent_at is not null then 'sent' else 'pending' end`.execute(db)
  // A second `confirmed` row for one Application would be a second success email; keep the earliest.
  await sql`delete from notification_outbox o using notification_outbox earlier
    where o.kind = 'confirmed' and earlier.kind = 'confirmed' and o.application_id = earlier.application_id
      and (earlier.created_at, earlier.id) < (o.created_at, o.id)`.execute(db)
  await sql`create unique index notification_outbox_confirmed_once on notification_outbox (application_id) where kind = 'confirmed'`.execute(db)
  await sql`create unique index notification_outbox_summary_once on notification_outbox (wat_day) where kind = 'daily_summary'`.execute(db)
  await sql`create index notification_outbox_due on notification_outbox (created_at) where status in ('pending', 'sending')`.execute(db)
  await sql`create index notification_outbox_last_failed on notification_outbox (last_failed_at desc) where status = 'failed'`.execute(db)
  await db.schema
    .createTable("notification_sender_state")
    .addColumn("singleton", "boolean", (c) => c.primaryKey().defaultTo(true).check(sql`singleton`))
    .addColumn("configured", "boolean", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull())
    .execute()
}
