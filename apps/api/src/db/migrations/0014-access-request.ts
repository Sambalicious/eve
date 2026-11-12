import { type Kysely, sql } from "kysely"

/**
 * EPIC-0003 (architecture.r1 7.7): public access requests.
 *
 * - `access_request` holds only the email, note, received time, the coalesce key,
 *   a keyed IP hash (cleared after 24 hours), the 24-hour window and the delivery
 *   status. No raw IP, name or user agent.
 * - `access_request_drop` counts silent drops (honeypot, fill time) toward the
 *   per-IP limit (AC 11.12). No content.
 * - `notification_outbox` gains `access_request` (one row per window, carrying
 *   no PII: the sender reads the window's requests at send time) and
 *   `access_request_cap` (one row per UTC day, stored in the legacy-named
 *   `wat_day`). There is deliberately no foreign key from the outbox to
 *   `access_request`: retention may delete a window's first row before later ones.
 *
 * No Candidate code path reads these tables (AC 11.23).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table access_request (
    id uuid primary key,
    email text not null check (char_length(email) between 3 and 254),
    email_key text not null check (email_key = lower(email)),
    note text not null default '' check (char_length(note) <= 500),
    created_at timestamptz not null,
    ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
    window_id uuid not null,
    status text not null default 'waiting' check (status in ('waiting', 'sent', 'failed'))
  )`.execute(db)
  await sql`create index access_request_created on access_request (created_at)`.execute(db)
  await sql`create index access_request_ip on access_request (ip_hash, created_at) where ip_hash is not null`.execute(db)
  await sql`create index access_request_window on access_request (email_key, created_at desc)`.execute(db)
  await sql`create index access_request_window_id on access_request (window_id)`.execute(db)

  await sql`create table access_request_drop (
    id uuid primary key,
    ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
    reason text not null check (reason in ('honeypot', 'fill_time')),
    created_at timestamptz not null
  )`.execute(db)
  await sql`create index access_request_drop_ip on access_request_drop (ip_hash, created_at)`.execute(db)

  await sql`alter table notification_outbox
    drop constraint notification_outbox_kind_check,
    drop constraint notification_outbox_summary_day`.execute(db)
  await sql`alter table notification_outbox
    add constraint notification_outbox_kind_check check (kind in
      ('confirmed', 'blocked', 'uncertain', 'daily_summary', 'cost_pause', 'access_request', 'access_request_cap')),
    add constraint notification_outbox_summary_day check ((kind in ('daily_summary', 'access_request_cap')) = (wat_day is not null)),
    add column access_request_window_id uuid,
    add constraint notification_outbox_access_request_window check ((kind = 'access_request') = (access_request_window_id is not null))`.execute(db)
  await sql`comment on column notification_outbox.wat_day is 'WAT day for daily_summary; UTC day of the cap for access_request_cap (legacy name)'`.execute(db)
  await sql`create unique index notification_outbox_access_request_once on notification_outbox (access_request_window_id) where kind = 'access_request'`.execute(db)
  await sql`create unique index notification_outbox_access_request_cap_once on notification_outbox (wat_day) where kind = 'access_request_cap'`.execute(db)
}
