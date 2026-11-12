import { type HiddenReason, type RoleFamilyValue, type SeniorityFloor, roleFamilySchema } from "@eve/contracts"
import type { RawBuilder } from "kysely"

import { sql } from "../db/sql.js"
import type { CandidateTx } from "../db/tenant-database.js"
import { sharePreferences } from "../preferences/preferences-lock.js"

/**
 * EPIC-0006 (architecture.r1 "Visibility module"): the one definition of a
 * hidden Job Posting, per Candidate, computed at read time and never stored.
 * Two forms that must agree: `hiddenReasonSql` / `visibleSql` (a fragment over
 * a `job_posting` alias) and `hiddenReason` (TypeScript). The agreement test
 * (`test/visibility-agreement.int-spec.ts`) runs both over the same facts.
 *
 * A posting is hidden for a Candidate when, in this order (AC-3.4):
 * 1. off_target: titled, and skipped as not_software_role, or with no family,
 *    or a family outside the Candidate's targets (AC-1.7);
 * 2. below_seniority_floor: titled, the floor hides entry level, and the marker
 *    is `entry` (AC-2.2);
 * 3. undated: no posted date (AC-5.5);
 * 4. older_than_60_days: posted before 00:00 WAT today minus 60 days, so age
 *    61 or more (AC-6.2).
 * Every input is a shared `job_posting` fact except the Candidate's targets and
 * floor (their `job_criteria` row, read in the same transaction) and the WAT
 * date of the request.
 *
 * EPIC-0010 (OQ-5, PD-2.5): a `pasted_description` posting is never hidden. Both
 * forms exempt it, so every caller (lists, rank, the evaluator gate, the create,
 * samples, notifications) inherits the exemption.
 */
export type VisibilityContext = Readonly<{
  targets: readonly RoleFamilyValue[]
  hideEntryLevel: boolean
  /** 00:00 WAT on the request's WAT date, minus 60 days. A posting with `posted_at < cutoff` is older than 60 days. */
  cutoff: Date
  /** The request moment, for `ageDays`. */
  now: Date
}>

/** The shared facts the rule reads. `titled` is `title_folded is not null` (a non-blank title). */
export type VisibilityFacts = Readonly<{
  titled: boolean
  prefilterSkip: string | null
  roleFamily: string | null
  seniorityMarker: string | null
  postedAt: Date | null
  /** EPIC-0010: `job_posting.origin = 'pasted_description'`; such a posting is never hidden. */
  pastedDescription: boolean
}>

export type CriteriaVisibility = Readonly<{ targetRoleFamilies: readonly string[]; seniorityFloor: SeniorityFloor }>

const DAY_MS = 86_400_000
/** Africa/Lagos is UTC+1 all year (no daylight saving; CONTEXT.md). */
const WAT_OFFSET_MS = 3_600_000
const MAX_AGE_DAYS = 60

/** The WAT calendar date of an instant, `YYYY-MM-DD`. */
export function watDate(instant: Date): string {
  return new Date(instant.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10)
}

/** 00:00 WAT on the WAT date of `instant`. */
export function startOfWatDay(instant: Date): Date {
  return new Date(Date.parse(`${watDate(instant)}T00:00:00Z`) - WAT_OFFSET_MS)
}

/** Whole WAT calendar days from the posted date to `now` (AC-6.1). Never negative. */
export function ageDays(postedAt: Date, now: Date): number {
  return Math.max(0, Math.round((startOfWatDay(now).getTime() - startOfWatDay(postedAt).getTime()) / DAY_MS))
}

/** Unknown stored entries (none pass the CHECK) are dropped; the result is in catalog order. */
export function buildVisibilityContext(criteria: CriteriaVisibility, now: Date): VisibilityContext {
  const targets = roleFamilySchema.options.filter((family) => criteria.targetRoleFamilies.includes(family))
  return {
    targets,
    hideEntryLevel: criteria.seniorityFloor === "hide_entry_level",
    cutoff: new Date(startOfWatDay(now).getTime() - MAX_AGE_DAYS * DAY_MS),
    now,
  }
}

/**
 * The scope Candidate's context, from their `job_criteria` row in `tx`. With
 * `lock: "share"` the row is read FOR SHARE, so the caller serialises against
 * a save (which holds FOR UPDATE). RLS hides other Candidates' rows, so a
 * wrong ID throws instead of reading someone else's settings.
 */
export async function visibilityContext(tx: CandidateTx, candidateId: string, now: Date, lock?: "share"): Promise<VisibilityContext> {
  let query = tx.selectFrom("job_criteria").select(["target_role_families", "seniority_floor"]).where("candidate_id", "=", candidateId)
  // EPIC-0002 B1 lock order: a share lock on job_criteria comes after the Job Preferences row FOR SHARE.
  if (lock === "share") {
    await sharePreferences(tx, candidateId)
    query = query.forShare()
  }
  const row = await query.executeTakeFirstOrThrow()
  return buildVisibilityContext({ targetRoleFamilies: row.target_role_families, seniorityFloor: row.seniority_floor }, now)
}

/** TypeScript twin of `hiddenReasonSql`. */
export function hiddenReason(facts: VisibilityFacts, ctx: VisibilityContext): HiddenReason | null {
  if (facts.pastedDescription) return null
  if (facts.titled) {
    const onTarget = facts.prefilterSkip === null && facts.roleFamily !== null && (ctx.targets as readonly string[]).includes(facts.roleFamily)
    if (!onTarget) return "off_target"
    if (ctx.hideEntryLevel && facts.seniorityMarker === "entry") return "below_seniority_floor"
  }
  if (facts.postedAt === null) return "undated"
  if (facts.postedAt.getTime() < ctx.cutoff.getTime()) return "older_than_60_days"
  return null
}

const column = (alias: string, name: string) => sql.ref(`${alias}.${name}`)

function reasonConditions(alias: string, ctx: VisibilityContext): Record<HiddenReason, RawBuilder<boolean>> {
  const titled = sql`${column(alias, "title_folded")} is not null`
  const targets = sql`${[...ctx.targets]}::text[]`
  const shared = sql`${column(alias, "origin")} <> 'pasted_description'`
  return {
    off_target: sql<boolean>`(${shared} and ${titled} and (${column(alias, "prefilter_skip")} is not null or ${column(alias, "role_family")} is null or not (${column(alias, "role_family")} = any(${targets}))))`,
    below_seniority_floor: sql<boolean>`(${shared} and ${titled} and ${ctx.hideEntryLevel}::boolean and ${column(alias, "seniority_marker")} is not distinct from 'entry')`,
    undated: sql<boolean>`(${shared} and ${column(alias, "posted_at")} is null)`,
    older_than_60_days: sql<boolean>`(${shared} and ${column(alias, "posted_at")} < ${ctx.cutoff}::timestamptz)`,
  }
}

const REASON_ORDER: readonly HiddenReason[] = ["off_target", "below_seniority_floor", "undated", "older_than_60_days"]

/** The first hidden reason (AC-3.4 order) for `alias` (a `job_posting` row), or null when visible. Every value is bound. */
export function hiddenReasonSql(alias: string, ctx: VisibilityContext): RawBuilder<HiddenReason | null> {
  const conditions = reasonConditions(alias, ctx)
  const whens = REASON_ORDER.map((reason) => sql`when ${conditions[reason]} then ${sql.lit(reason)}`)
  return sql<HiddenReason | null>`(case ${sql.join(whens, sql` `)} else null end)`
}

/** True when `alias` is visible for the context's Candidate. */
export function visibleSql(alias: string, ctx: VisibilityContext): RawBuilder<boolean> {
  const conditions = reasonConditions(alias, ctx)
  return sql<boolean>`(not (${sql.join(REASON_ORDER.map((reason) => conditions[reason]), sql` or `)}))`
}
