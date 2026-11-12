import { type Kysely, sql } from "kysely"

/**
 * EPIC-0005: Stack posts (architecture.md "Data model: migration 0013-stack-posts").
 *
 * - `alert_feed_verification`: one installation-wide row. No row = not verified.
 * - `alert_feed`: Candidate-registered Google Alerts feed URLs (pattern repeated
 *   as a check), optional label, last successful read, last failure.
 * - `stack_post`: the eight stored fields of AC 5.4. `published_at` null means
 *   the list shows "Found" with the first-seen time.
 * - `stack_post_run`: one row per scheduled read run, for AC 6.6 and operability.
 *
 * Numbered after origin/main's `0011-postings-paging-filter` and EPIC-0004's
 * `0012-job-criteria` (D-E5-9). Additive only: no existing table changes. No
 * candidate identifier (AC 4.9). Grants come from migrate-and-grant.
 *
 * Pure SQL, no imports from app code: migrations are history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table alert_feed_verification (
    singleton boolean primary key default true check (singleton),
    verified_on date not null,
    verification_basis text not null check (char_length(verification_basis) between 1 and 500),
    updated_at timestamptz not null default now()
  )`.execute(db)

  await sql`create table alert_feed (
    id uuid primary key,
    url text not null unique
      check (char_length(url) <= 512 and url ~ '^https://www\\.google\\.com/alerts/feeds/[0-9]+/[0-9]+$'),
    label text check (label is null or char_length(label) between 1 and 60),
    created_at timestamptz not null,
    last_read_at timestamptz,
    last_failure_reason text check (last_failure_reason in
      ('not_reachable', 'unexpected_response', 'redirected', 'not_a_feed', 'too_large', 'timed_out')),
    last_failed_at timestamptz,
    check ((last_failure_reason is null) = (last_failed_at is null))
  )`.execute(db)
  await sql`create index alert_feed_created_idx on alert_feed (created_at, id)`.execute(db)

  await sql`create table stack_post (
    id uuid primary key,
    canonical_url text not null unique
      check (char_length(canonical_url) <= 2048 and canonical_url like 'https://www.linkedin.com/%'),
    kind text not null check (kind in ('post', 'article')),
    title text not null default '' check (char_length(title) <= 300),
    snippet text not null default '' check (char_length(snippet) <= 1000),
    published_at timestamptz,
    matched_technologies text[] not null default '{}' check (cardinality(matched_technologies) <= 40),
    source_feed_id uuid references alert_feed(id) on delete set null,
    first_seen_at timestamptz not null
  )`.execute(db)
  await sql`create index stack_post_list_idx on stack_post ((coalesce(published_at, first_seen_at)) desc, first_seen_at desc, id desc)`.execute(db)
  await sql`create index stack_post_first_seen_idx on stack_post (first_seen_at)`.execute(db)
  await sql`create index stack_post_source_feed_idx on stack_post (source_feed_id)`.execute(db)

  await sql`create table stack_post_run (
    id uuid primary key,
    started_at timestamptz not null,
    finished_at timestamptz,
    outcome text not null check (outcome in ('running', 'completed', 'skipped_global_pause', 'skipped_unverified')),
    feeds_read integer not null default 0,
    feeds_failed integer not null default 0,
    posts_stored integer not null default 0,
    posts_deleted integer not null default 0
  )`.execute(db)
  await sql`create index stack_post_run_started_idx on stack_post_run (started_at)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table stack_post_run`.execute(db)
  await sql`drop table stack_post`.execute(db)
  await sql`drop table alert_feed`.execute(db)
  await sql`drop table alert_feed_verification`.execute(db)
}
