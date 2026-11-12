import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0007 Phase 3 (api-contract.r1.md "Migration", architecture.r2.md;
 * threat model r1 P3-3, P3-16). Four Candidate-data tables, mirroring the
 * EPIC-0005 tables as amended by 0016 and 0017:
 *
 * - `hiring_alert_feed`: a Candidate's Hiring Alert feeds (own limit of 10, D5).
 * - `hiring_post`: posts kept from those feeds; de-duplicated per Candidate.
 * - `hiring_post_run`: one row per scheduled Hiring read run per Candidate.
 * - `hiring_feed_verification` (D14): each Candidate's own permitted-use record,
 *   one row at most, keyed by `candidate_id`.
 *
 * Each table has forced RLS and one `<table>_candidate` policy whose text is
 * the `stack_post` Candidate policy from 0017. Grants come from
 * migrate-and-grant. No backfill (D16): nothing is copied from
 * `alert_feed_verification`, so no Candidate is verified after this runs. No
 * EPIC-0005 table is changed.
 *
 * Frozen and pure SQL: imports nothing from the app. `down` drops only these
 * four tables (development only).
 */
export const HIRING_POSTS_MARKER = "0021-hiring-posts"

/** The four tables, in creation order. Candidate data: deletion cascades from `candidate`. */
export const HIRING_TABLES = ["hiring_alert_feed", "hiring_post", "hiring_post_run", "hiring_feed_verification"] as const

/** Copied from 0017 (`stack_post_candidate`). */
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  await run(sql`create table hiring_alert_feed (
    candidate_id uuid not null references candidate(id) on delete cascade,
    id uuid primary key,
    url text not null
      check (char_length(url) <= 512 and url ~ '^https://www\\.google\\.com/alerts/feeds/[0-9]+/[0-9]+$'),
    label text check (label is null or char_length(label) between 1 and 60),
    created_at timestamptz not null,
    last_read_at timestamptz,
    last_failure_reason text check (last_failure_reason in
      ('not_reachable', 'unexpected_response', 'redirected', 'not_a_feed', 'too_large', 'timed_out')),
    last_failed_at timestamptz,
    check ((last_failure_reason is null) = (last_failed_at is null))
  )`)
  await run(sql`create unique index hiring_alert_feed_candidate_url_idx on hiring_alert_feed (candidate_id, url)`)
  await run(sql`create unique index hiring_alert_feed_candidate_id_idx on hiring_alert_feed (candidate_id, id)`)
  await run(sql`create index hiring_alert_feed_created_idx on hiring_alert_feed (candidate_id, created_at, id)`)

  await run(sql`create table hiring_post (
    candidate_id uuid not null references candidate(id) on delete cascade,
    id uuid primary key,
    canonical_url text not null
      check (char_length(canonical_url) <= 2048 and canonical_url like 'https://www.linkedin.com/%'),
    kind text not null check (kind in ('post', 'article')),
    title text not null default '' check (char_length(title) <= 300),
    snippet text not null default '' check (char_length(snippet) <= 1000),
    published_at timestamptz,
    matched_technologies text[] not null default '{}' check (cardinality(matched_technologies) <= 40),
    source_feed_id uuid,
    first_seen_at timestamptz not null,
    constraint hiring_post_source_feed_fk foreign key (candidate_id, source_feed_id)
      references hiring_alert_feed (candidate_id, id) on delete set null (source_feed_id)
  )`)
  await run(sql`create unique index hiring_post_candidate_url_idx on hiring_post (candidate_id, canonical_url)`)
  await run(sql`create index hiring_post_list_idx on hiring_post (candidate_id, (coalesce(published_at, first_seen_at)) desc, first_seen_at desc, id desc)`)
  await run(sql`create index hiring_post_first_seen_idx on hiring_post (candidate_id, first_seen_at)`)
  await run(sql`create index hiring_post_source_feed_idx on hiring_post (candidate_id, source_feed_id)`)

  await run(sql`create table hiring_post_run (
    candidate_id uuid not null references candidate(id) on delete cascade,
    id uuid primary key,
    started_at timestamptz not null,
    finished_at timestamptz,
    outcome text not null check (outcome in ('running', 'completed', 'skipped_global_pause', 'skipped_unverified')),
    feeds_read integer not null default 0,
    feeds_failed integer not null default 0,
    posts_stored integer not null default 0,
    posts_deleted integer not null default 0
  )`)
  await run(sql`create index hiring_post_run_started_idx on hiring_post_run (candidate_id, started_at)`)

  await run(sql`create table hiring_feed_verification (
    candidate_id uuid primary key references candidate(id) on delete cascade,
    verified_on date not null,
    verification_basis text not null check (char_length(verification_basis) between 1 and 500),
    updated_at timestamptz not null
  )`)

  for (const table of HIRING_TABLES) {
    const t = sql.table(table)
    await run(sql`alter table ${t} enable row level security`)
    await run(sql`alter table ${t} force row level security`)
    await run(sql`create policy ${sql.id(`${table}_candidate`)} on ${t} for all
      using (candidate_id = ${CURRENT_CANDIDATE}) with check (candidate_id = ${CURRENT_CANDIDATE})`)
  }
  await recordSchemaMarker(db, HIRING_POSTS_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${HIRING_POSTS_MARKER}`.execute(db)
  for (const table of [...HIRING_TABLES].reverse()) await sql`drop table ${sql.table(table)}`.execute(db)
}
