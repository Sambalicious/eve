import { type Kysely, sql } from "kysely"

/**
 * EPIC-0004: Job criteria (architecture.md "Storage: migration 0012-job-criteria").
 *
 * - `job_criteria`: the Candidate's minimum core Match (whole percent 1..100)
 *   and two lists of up to 20 entries, stored trimmed as typed, with a version
 *   that every save increments. Seeded from `evaluation_setting.match_threshold`
 *   × 100, rounded half up (Postgres `round(numeric)` rounds half away from
 *   zero) and clamped to 1..100, or 70 when no row exists (AC 7.1, 7.4).
 * - `job_posting.technologies`: verified technologies; null = not checked.
 * - `match_evidence.criteria_version` / `criteria_technologies`: the stamp of
 *   the criteria each decision used (AC 5.7).
 * - Re-decides step 4 (the lists start empty, so step 5 cannot apply) for
 *   ranked and `weak_core_match` postings with evidence, from stored counts,
 *   with no AI call. Kysely runs this migration in one transaction, so the
 *   re-decision and the rest succeed or fail together.
 * - `evaluation_setting.match_threshold` is kept and read by no code after
 *   this migration (AC 7.2).
 * - Repair wave 1 (rollback): every new column the previous image writes
 *   without naming it has a default. `criteria_version` defaults to 0, meaning
 *   "decided by code that predates Job criteria"; real versions start at 1, and
 *   the next save restamps every ranked or skipped row. `criteria_technologies`
 *   defaults to '{}' and `job_posting.technologies` is nullable. The previous
 *   image's `migrate` still refuses a database with 0012 applied (Kysely has no
 *   option for an unknown executed migration), so a rollback needs the manual
 *   step in architecture.r1.md "Rollback".
 *
 * Pure SQL, no imports from app code: migrations are history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table job_criteria (
    singleton boolean primary key default true check (singleton),
    min_core_match_percent smallint not null check (min_core_match_percent between 1 and 100),
    frameworks text[] not null default '{}' check (cardinality(frameworks) <= 20),
    technologies text[] not null default '{}' check (cardinality(technologies) <= 20),
    version integer not null default 1 check (version >= 1),
    updated_at timestamptz not null default now()
  )`.execute(db)

  const stored = await sql<{ stored: string | null }>`select (select match_threshold::text from evaluation_setting limit 1) as stored`.execute(db)
  const storedThreshold = stored.rows[0]?.stored ?? null

  const seeded = await sql<{ percent: number }>`
    insert into job_criteria (min_core_match_percent)
    values (coalesce((select least(100, greatest(1, round(match_threshold * 100)))::int from evaluation_setting limit 1), 70))
    on conflict (singleton) do nothing
    returning min_core_match_percent as percent`.execute(db)
  const percent = seeded.rows[0]?.percent ?? 70

  await sql`alter table job_posting
    add column technologies jsonb check (technologies is null or jsonb_typeof(technologies) = 'array')`.execute(db)
  await sql`alter table match_evidence
    add column criteria_version integer not null default 0 check (criteria_version >= 0),
    add column criteria_technologies text[] not null default '{}'`.execute(db)

  // Step 4 only: strong means covered * 100 >= percent * total, in integers.
  const changed = await sql<{ id: string }>`
    with decided as (
      select p.id,
             (m.covered_count * 100 >= ${percent} * m.total_count) as strong
      from job_posting p
      join match_evidence m on m.job_posting_id = p.id
      where m.total_count > 0
        and (p.status = 'ranked' or (p.status = 'skipped' and p.skip_reason = 'weak_core_match'))
    ),
    flipped as (
      select id, strong from decided d
      join job_posting p using (id)
      where (p.status = 'ranked') <> d.strong
    ),
    evidence as (
      update match_evidence m
      set verdict = case when f.strong then 'strong' else 'weak' end,
          weak_reason = case when f.strong then null else 'coverage_below_threshold' end
      from flipped f
      where m.job_posting_id = f.id
      returning m.job_posting_id
    )
    update job_posting p
    set status = case when f.strong then 'ranked' else 'skipped' end,
        skip_reason = case when f.strong then null else 'weak_core_match' end,
        skip_detail = null
    from flipped f
    where p.id = f.id
    returning p.id`.execute(db)

  await sql`update match_evidence set criteria_version = 1`.execute(db)
  await sql`update match_evidence m set threshold = ${percent}::numeric / 100
    from job_posting p
    where p.id = m.job_posting_id and p.status in ('ranked', 'skipped')`.execute(db)

  await sql`comment on column evaluation_setting.match_threshold is 'Superseded by job_criteria (EPIC-0004). Read by no code.'`.execute(db)

  process.stdout.write(
    `${JSON.stringify({ migration: "0012-job-criteria", storedThreshold, minCoreMatchPercent: percent, changedPostings: changed.rows.length })}\n`
  )
}
