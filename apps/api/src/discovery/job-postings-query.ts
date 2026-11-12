import type { PostingsTabValue, RoleFamilyValue } from "@eve/contracts"
import { type Kysely, type RawBuilder, type Selectable } from "kysely"
import { sql } from "../db/sql.js"

import type { CandidatePostingTable, Database, JobPostingTable } from "../db/schema.js"
import type { PostingKey } from "./posting-cursor.js"
import { type RoleFamily, TIER } from "./rules/ranking.js"
import { stuckSql } from "./stuck.js"
import { type VisibilityContext, hiddenReasonSql, visibleSql } from "./visibility.js"

/**
 * Slice 8: one page of `GET /v1/job-postings`, served by Postgres with keyset
 * pagination (8P.5 to 8P.8, 8K).
 *
 * Orders
 * - Skipped and All: `discovered_at desc, id asc`, at full microsecond
 *   precision, the Candidate's own `candidate_posting.discovered_at` (index
 *   `candidate_posting_newest_idx` and, per tab, `candidate_posting_status_newest_idx`).
 * - Ranked: the `rankPostings` order, in SQL over the ranked rows only:
 *   tier asc (a CASE generated from TIER; null or unknown family ranks as
 *   `other`), coverage desc (`covered::float8 / total`, the same IEEE division
 *   JavaScript does; no evidence or a zero total is 0), employer board first,
 *   `discovered_at` asc truncated to the millisecond (rankPostings compares
 *   `Date.getTime()`, and pg's Date parser truncates), id asc (uuid byte order,
 *   which equals `localeCompare` on lower-case uuid text).
 *
 * Rank is `row_number()` over every ranked posting, computed before the filter
 * and the cursor, so it is the global submission position whatever the view
 * shows (8K.1, D8-4). Its cost is one sort of the ranked rows per request.
 *
 * Filter: families any-of on the stored `role_family` (null never matches);
 * keyword as `strpos(title_folded, folded keyword) > 0`. `strpos` has no
 * wildcard characters, so `%`, `_` and `\` match only themselves, and no
 * keyword changes the plan (8F.7). `title_folded` is `foldForKeywords(title)`,
 * written at ingestion (migration 0011-postings-paging-filter backfills old rows); null when untitled.
 *
 * EPIC-0002 A1 (architecture r4 "Job Postings per Candidate"): every query
 * starts from the Candidate's `candidate_posting cp` rows (named by
 * `cp.candidate_id`, backed by RLS) joined to the shared facts in
 * `job_posting p`. Status, skip reason, origin and discovery time come from
 * `cp`; title, `title_folded`, `role_family` and the employer board from `p`.
 * Match evidence joins on `(candidate_id, job_posting_id)`. Rank, counts and
 * cursors therefore cover only this Candidate's postings. EPIC-0002 B1: the tier
 * map is the Candidate's (`rankTiersOf(preferences.roleFamilyTiers)`), read once
 * per request in the same transaction.
 *
 * EPIC-0006 (AC-3.2, AC-3.3): every query ANDs `visibleSql('p', ctx)`, so
 * hidden postings appear on no tab and count in no total, and ranks number
 * only the Candidate's visible ranked postings. `not_checked` rows appear on
 * the All tab only. A cursor issued before a save still decodes; rows hidden
 * since then drop out of later pages (AC-3.7).
 */

export type PageFilter = Readonly<{ families: readonly RoleFamilyValue[]; foldedKeyword: string | null }>

/** A posting as one Candidate sees it: the shared facts plus their own `candidate_posting` state. */
export type CandidatePostingView = Omit<Selectable<JobPostingTable>, "posting_text" | "structured" | "title_folded" | "technologies" | "ats_skills" | "forward_statements" | "prefilter_skip" | "seniority_marker" | "owner_candidate_id" | "paste_fingerprint"> &
  Omit<Selectable<CandidatePostingTable>, "candidate_id" | "job_posting_id" | "preferences_version" | "checking_since" | "evaluation_attempts">

export type PageRow = Readonly<
  CandidatePostingView & {
    rank: number | null
    covered_count: number | null
    total_count: number | null
    /** EPIC-0004: the threshold the stored decision used (numeric text); null without Match evidence. */
    threshold: string | null
    /** EPIC-0004 AC 4.5: `technologies is null`; the list never carries the technology items. */
    technologies_missing: boolean
    tier: number
    /** Ranked tab only: ATS fit 0 to 100, -1 without one (0029). */
    ats_fit?: number | null
    /** Newest-first tabs: the stored ATS fit, null without one. */
    posting_ats_fit?: number | null
    from_employer_board: boolean
    discovered_us: string
    rank_discovered_us: string
  }
>

const SKIPPED_STATUSES = ["excluded", "skipped"] as const
/** EPIC-0002 B1 (D17): the reason that moves a skip from Skipped by rules and All to Excluded families. */
const EXCLUDED_FAMILY = sql.lit("excluded_role_family")
/** v1.28.0 manual lane: skipped only because Eve cannot submit through the employer's system. */
const MANUAL_APPLY = sql.lit("unsupported_application_system")

/** A Candidate's tier sort keys (`rankTiersOf(preferences.roleFamilyTiers)`), one per catalog family. */
export type TierMap = Readonly<Record<RoleFamily, number>>

/**
 * `CASE role_family WHEN … END` over the Candidate's tier map (EPIC-0002 B1,
 * r4 "tierSql(tiers)"). Every family and tier is an integer literal from a
 * closed set (the catalog keys and 0 to 3), so nothing user-typed reaches the
 * SQL text. Anything else (null included) gets `other`'s tier. `rankPostings`
 * takes the same map, so the SQL order and the in-memory order cannot drift.
 */
export function tierSql(column: RawBuilder<unknown>, tiers: TierMap = TIER): RawBuilder<number> {
  const whens = (Object.keys(TIER) as RoleFamily[])
    .filter((family) => family !== "other")
    .map((family) => sql`when ${sql.lit(family)} then ${sql.lit(integerTier(tiers[family]))}`)
  return sql<number>`(case ${column} ${sql.join(whens, sql` `)} else ${sql.lit(integerTier(tiers.other))} end)`
}

function integerTier(value: number | undefined): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 9) throw new Error("tier sort key out of range")
  return value as number
}

const coverageSql = (covered: RawBuilder<unknown>, total: RawBuilder<unknown>) =>
  sql`(case when ${total} > 0 then ${covered}::float8 / ${total}::float8 else 0::float8 end)`
const usOf = (timestamp: RawBuilder<unknown>) => sql<string>`((extract(epoch from ${timestamp}) * 1000000)::bigint)::text`
const timestampOf = (us: string) => sql`(timestamptz 'epoch' + ${us}::bigint * interval '1 microsecond')`

const COLUMNS = sql`p.id, p.application_url, p.requisition_id, p.apply_url, p.application_system, p.apply_mode, cp.origin,
  p.employer_board_id, p.remote_board_key, p.attribution_name, p.attribution_url, p.title, p.company, cp.status,
  cp.skip_reason, cp.skip_detail, cp.evaluation_failure, p.role_family, cp.discovered_at, cp.evaluated_at,
  p.posted_at, p.posted_date_kind, (p.technologies is null) as technologies_missing`

/** The Candidate's postings: their `candidate_posting` rows joined to the shared facts. */
const POSTINGS = sql`candidate_posting cp join job_posting p on p.id = cp.job_posting_id
  left join match_evidence m on m.job_posting_id = cp.job_posting_id and m.candidate_id = cp.candidate_id`

/** Every ranked posting with its sort columns and global rank. */
function rankedRows(candidateId: string, ctx: VisibilityContext, tiers: TierMap): RawBuilder<unknown> {
  const tier = tierSql(sql.ref("p.role_family"), tiers)
  const covered = sql`coalesce(m.covered_count, 0)`
  const total = sql`coalesce(m.total_count, 0)`
  const ms = sql`date_trunc('milliseconds', cp.discovered_at)`
  const fromEmployer = sql`(cp.origin = 'employer_board')`
  // ATS fit (0029) right after the Candidate's tier: -1 without one, so those sort last within a tier.
  const atsFit = sql`coalesce(m.ats_fit, -1)`
  return sql`
    select ${COLUMNS}, p.title_folded, m.covered_count, m.total_count, m.threshold,
      ${tier} as tier, ${atsFit} as ats_fit, ${coverageSql(covered, total)} as coverage, ${fromEmployer} as from_employer_board,
      ${ms} as rank_discovered_at, ${usOf(sql.ref("cp.discovered_at"))} as discovered_us, ${usOf(ms)} as rank_discovered_us,
      (row_number() over (order by ${tier}, ${atsFit} desc, ${coverageSql(covered, total)} desc, ${fromEmployer} desc, ${ms}, p.id))::int as rank
    from ${POSTINGS}
    where cp.candidate_id = ${candidateId}::uuid and cp.status = 'ranked' and ${visibleSql("p", ctx)}`
}

function filterParts(alias: string, filter: PageFilter): RawBuilder<unknown>[] {
  const parts: RawBuilder<unknown>[] = []
  if (filter.families.length > 0) parts.push(sql`${sql.ref(`${alias}.role_family`)} in (${sql.join(filter.families.map((family) => sql`${family}`))})`)
  if (filter.foldedKeyword !== null) parts.push(sql`strpos(${sql.ref(`${alias}.title_folded`)}, ${filter.foldedKeyword}) > 0`)
  return parts
}

/**
 * EPIC-0002 B1 four tabs (api-contract-b1 "Skip reasons and tabs", r4 "B: four
 * tabs"). Each posting is on exactly one of All and Excluded families; a
 * skipped row with a null reason stays on Skipped by rules (`is distinct from`).
 */
function tabParts(alias: string, tab: PostingsTabValue): RawBuilder<unknown>[] {
  const status = sql.ref(`${alias}.status`)
  const reason = sql.ref(`${alias}.skip_reason`)
  if (tab === "ranked") return [sql`${status} = 'ranked'`]
  if (tab === "manual") return [sql`${status} = 'skipped'`, sql`${reason} is not distinct from ${MANUAL_APPLY}`]
  if (tab === "skipped")
    return [
      sql`${status} in (${sql.join(SKIPPED_STATUSES.map((value) => sql.lit(value)))})`,
      sql`${reason} is distinct from ${EXCLUDED_FAMILY}`,
      sql`${reason} is distinct from ${MANUAL_APPLY}`,
    ]
  if (tab === "excluded_family") return [sql`${status} = 'skipped'`, sql`${reason} = ${EXCLUDED_FAMILY}`]
  return [sql`not (${status} = 'skipped' and ${reason} is not distinct from ${EXCLUDED_FAMILY})`]
}

const and = (parts: RawBuilder<unknown>[]) => (parts.length === 0 ? sql`true` : sql.join(parts, sql` and `))

function rankedAfter(key: Extract<PostingKey, { kind: "ranked" }>): RawBuilder<unknown> {
  const cov = coverageSql(sql`${key.covered}::int`, sql`${key.total}::int`)
  const at = timestampOf(key.discoveredUs)
  return sql`(r.tier > ${key.tier} or (r.tier = ${key.tier} and (r.ats_fit < ${key.atsFit} or (r.ats_fit = ${key.atsFit} and (r.coverage < ${cov} or (r.coverage = ${cov} and (
    r.from_employer_board < ${key.fromEmployerBoard} or (r.from_employer_board = ${key.fromEmployerBoard} and (
      r.rank_discovered_at > ${at} or (r.rank_discovered_at = ${at} and r.id > ${key.id}::uuid))))))))))`
}

function newestAfter(key: Extract<PostingKey, { kind: "newest" }>): RawBuilder<unknown> {
  const at = timestampOf(key.discoveredUs)
  return sql`(cp.discovered_at < ${at} or (cp.discovered_at = ${at} and cp.job_posting_id > ${key.id}::uuid))`
}

/**
 * At most `limit + 1` rows after `after` (null: from the start), so the caller
 * knows whether a next page exists. Ranks on newest-first tabs come from
 * `ranksOf`, the same SQL order.
 */
export async function readPage(
  db: Kysely<Database>,
  candidateId: string,
  input: Readonly<{ tab: PostingsTabValue; filter: PageFilter; after: PostingKey | null; limit: number; ctx: VisibilityContext; tiers: TierMap }>
): Promise<PageRow[]> {
  const take = input.limit + 1
  if (input.tab === "ranked") {
    const parts = filterParts("r", input.filter)
    if (input.after?.kind === "ranked") parts.push(rankedAfter(input.after))
    const result = await sql<PageRow>`with r as (${rankedRows(candidateId, input.ctx, input.tiers)})
      select * from r where ${and(parts)}
      order by r.tier, r.ats_fit desc, r.coverage desc, r.from_employer_board desc, r.rank_discovered_at, r.id
      limit ${take}`.execute(db)
    return result.rows
  }
  const parts = [sql`cp.candidate_id = ${candidateId}::uuid`, ...tabParts("cp", input.tab), ...filterParts("p", input.filter), visibleSql("p", input.ctx)]
  if (input.after?.kind === "newest") parts.push(newestAfter(input.after))
  const result = await sql<Omit<PageRow, "rank">>`
    select ${COLUMNS}, m.covered_count, m.total_count, m.threshold, m.ats_fit as posting_ats_fit, ${tierSql(sql.ref("p.role_family"), input.tiers)} as tier,
      (cp.origin = 'employer_board') as from_employer_board,
      ${usOf(sql.ref("cp.discovered_at"))} as discovered_us, ${usOf(sql`date_trunc('milliseconds', cp.discovered_at)`)} as rank_discovered_us
    from ${POSTINGS}
    where ${and(parts)}
    order by cp.discovered_at desc, cp.job_posting_id
    limit ${take}`.execute(db)
  const ranks = await ranksOf(db, candidateId, input.ctx, input.tiers, result.rows.filter((row) => row.status === "ranked").map((row) => row.id))
  return result.rows.map((row) => ({ ...row, rank: ranks.get(row.id) ?? null }))
}

/** Exact count of the Candidate's postings matching the tab and the filter (8P.3). */
export async function countMatching(db: Kysely<Database>, candidateId: string, tab: PostingsTabValue, filter: PageFilter, ctx: VisibilityContext): Promise<number> {
  const parts = [sql`cp.candidate_id = ${candidateId}::uuid`, ...tabParts("cp", tab), ...filterParts("p", filter), visibleSql("p", ctx)]
  const result = await sql<{ n: string }>`select count(*)::text as n from candidate_posting cp join job_posting p on p.id = cp.job_posting_id where ${and(parts)}`.execute(db)
  return Number(result.rows[0]?.n ?? 0)
}

/** Global ranks of the given postings, from the same SQL order as the Ranked tab. Non-ranked and hidden ids are absent. */
export async function ranksOf(db: Kysely<Database>, candidateId: string, ctx: VisibilityContext, tiers: TierMap, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const result = await sql<{ id: string; rank: number }>`with r as (${rankedRows(candidateId, ctx, tiers)})
    select r.id, r.rank from r where r.id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})`.execute(db)
  return new Map(result.rows.map((row) => [row.id, row.rank]))
}

/** The keyset position of `row` in the tab's order. */
export function keyOf(tab: PostingsTabValue, row: PageRow): PostingKey {
  if (tab !== "ranked") return { kind: "newest", discoveredUs: row.discovered_us, id: row.id }
  const total = row.total_count ?? 0
  return {
    kind: "ranked",
    tier: Number(row.tier),
    atsFit: Number(row.ats_fit ?? -1),
    covered: total > 0 ? (row.covered_count ?? 0) : 0,
    total,
    fromEmployerBoard: row.from_employer_board,
    discoveredUs: row.rank_discovered_us,
    id: row.id,
  }
}

/** EPIC-0006: the counts every list response carries, over all of the Candidate's postings (no tab, filter or cursor). */
export type ListAggregate = Readonly<{
  hidden: Readonly<{ offTarget: number; belowSeniorityFloor: number; undated: number; olderThan60Days: number }>
  /** Visible `waiting_to_be_checked`. */
  waiting: number
  /** Visible `evaluation_failed` (any kind) + visible `not_checked` + (r4, AC-7.11) visible stuck `checking` (AC-7.3, AC-7.10). */
  recheckable: number
  /** Visible ranked, and visible skipped as weak_core_match or technology_mismatch (EPIC-0004 AC 6.3 inputs). */
  ranked: number
  criteriaSkipped: number
}>

/** One pass over the Candidate's `cp ⋈ p`: hidden counts by first reason (AC-3.4) and the visible counts. */
export async function listAggregate(db: Kysely<Database>, candidateId: string, ctx: VisibilityContext): Promise<ListAggregate> {
  const result = await sql<Record<"off_target" | "below_floor" | "undated" | "older" | "waiting" | "recheckable" | "ranked" | "criteria_skipped", number>>`
    with r as (
      select cp.status, cp.skip_reason, ${hiddenReasonSql("p", ctx)} as reason, ${stuckSql("cp", ctx.now)} as stuck
      from candidate_posting cp join job_posting p on p.id = cp.job_posting_id
      where cp.candidate_id = ${candidateId}::uuid
    )
    select
      count(*) filter (where reason = 'off_target')::int as off_target,
      count(*) filter (where reason = 'below_seniority_floor')::int as below_floor,
      count(*) filter (where reason = 'undated')::int as undated,
      count(*) filter (where reason = 'older_than_60_days')::int as older,
      count(*) filter (where reason is null and status = 'waiting_to_be_checked')::int as waiting,
      count(*) filter (where reason is null and (status in ('evaluation_failed', 'not_checked') or stuck))::int as recheckable,
      count(*) filter (where reason is null and status = 'ranked')::int as ranked,
      count(*) filter (where reason is null and status = 'skipped' and skip_reason in ('weak_core_match', 'technology_mismatch'))::int as criteria_skipped
    from r`.execute(db)
  const row = result.rows[0]
  return {
    hidden: { offTarget: row?.off_target ?? 0, belowSeniorityFloor: row?.below_floor ?? 0, undated: row?.undated ?? 0, olderThan60Days: row?.older ?? 0 },
    waiting: row?.waiting ?? 0,
    recheckable: row?.recheckable ?? 0,
    ranked: row?.ranked ?? 0,
    criteriaSkipped: row?.criteria_skipped ?? 0,
  }
}
