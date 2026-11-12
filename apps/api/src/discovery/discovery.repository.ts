import { createHash, randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import { type HiddenReason, type PostingsTabValue, type RoleFamilyValue, type SeniorityFloor, STEP3_DEFAULTS, roleFamilySchema } from "@eve/contracts"

import type { JobPostingStatus, RemoteBoardKey, StoredMatchItem, StoredRule, StoredTechnology } from "../db/schema.js"
import { CandidateScope } from "../db/candidate-scope.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, isLockTimeout, transactionTimeouts } from "../db/transaction-timeouts.js"
import { type ListAggregate, type PageFilter, type PageRow, countMatching, listAggregate, ranksOf, readPage } from "./job-postings-query.js"
import { type VisibilityContext, type VisibilityFacts, hiddenReason, visibilityContext, visibleSql } from "./visibility.js"
import { type PostingKey, tierMapHash } from "./posting-cursor.js"
import { tierMapIn } from "./tier-map.js"

/** v1.28.1: a transient failure the worker retries once, and the minimum age before it does (migration 0036). */
export const RETRYABLE_FAILURES = ["not_configured", "provider_error", "invalid_output", "timed_out"] as const
export const RETRY_ATTEMPTS_LIMIT = 2
export const RETRY_BACKOFF_MINUTES = 10
import { sharePreferences } from "../preferences/preferences-lock.js"
import { readPreferences } from "../preferences/preferences-read.js"
import { type PreferenceSkipReason, decidePreferenceSkip } from "./rules/preference-rules.js"
import { type EligibilityPreferences, eligibilityPreferencesOf } from "./rules/eligibility.js"
import type { StructuredFields } from "./rules/eligibility.js"
import { type PreFilterResult, type SharedPostingFacts, type StartingState, startingState } from "./pre-filters.js"
import { evaluationAllowed } from "./evaluation-allowed.js"
import { stuckSql } from "./stuck.js"
import { type PastedDescriptionInput, type PastedDescriptionResult, storePastedDescription } from "./pasted-description-store.js"
import { classifyTitle, reconcileRoleFamily } from "./rules/ranking.js"
import { foldForKeywords } from "./rules/rule-result.js"
import { seniorityMarker } from "./rules/seniority.js"

export type NewPosting = Readonly<{
  applicationUrl: string
  requisitionId: string
  applyUrl: string
  applicationSystem: string
  applyMode: "automatic" | "manual"
  origin: "employer_board" | "remote_board" | "pasted_link"
  employerBoardId: string | null
  remoteBoardKey: RemoteBoardKey | null
  attribution: Readonly<{ name: string; url: string }> | null
  title: string | null
  company: string | null
  postingText: string
  structured: StructuredFields
  discoveredAt: Date
  /** EPIC-0006 (AC-5.1 to 5.4): the bounded posted date; null when undated. */
  postedAt: Date | null
  postedDateKind: "published" | "updated" | null
}>

export type StoredPosting = Readonly<{ id: string; created: boolean }>

/** EPIC-0006: one list request's reads, from one transaction. */
/** The tier map changed between decoding a cursor and reading its page (EPIC-0002 B1). */
export class TierMapChangedError extends Error {
  constructor() {
    super("Tier map changed since the cursor was decoded")
    this.name = "TierMapChangedError"
  }
}

export type ListPage = Readonly<{ rows: PageRow[]; totalCount: number; aggregate: ListAggregate; criteria: StoredJobCriteria; operator: boolean; tierHash: string }>

/** The visibility facts of a row read with POSTING_LIST_COLUMNS. */
export function visibilityFactsOf(
  row: Readonly<{ title_folded: string | null; prefilter_skip: string | null; role_family: string | null; seniority_marker: string | null; posted_at: Date | null; origin: string }>
): VisibilityFacts {
  return {
    titled: row.title_folded !== null,
    prefilterSkip: row.prefilter_skip,
    roleFamily: row.role_family,
    seniorityMarker: row.seniority_marker,
    postedAt: row.posted_at,
    pastedDescription: row.origin === "pasted_description",
  }
}

/**
 * `storeOnce`'s result: `evaluate` is true when this Candidate's row waits for
 * evaluation ("checking"): a new visible row, or (EPIC-0006 AC-5.8) a held
 * `not_checked` row a backfill just made visible and this call claimed. When
 * `evaluationAllowed` says no (EPIC-0002 D13), such a row is stored
 * "waiting_to_be_checked" instead and `evaluate` is false.
 */
export type StoredForCandidate = StoredPosting & Readonly<{ state: StartingState; evaluate: boolean }>

/** What the evaluation found from the posting alone; the verdict is decided under the criteria lock. */
export type EvaluationRecord = Readonly<{
  roleFamily: RoleFamilyValue
  /**
   * EPIC-0002 B1 (feature :804, r1 E4): the Job Preferences version the run read
   * at its start, 0 with no record. Stored with the decision unless the verdict
   * transaction's steps 2 and 3 re-decide it under a newer version.
   */
  preferencesVersion: number
  eligibility: Readonly<{
    arrangement: "remote" | "relocation" | "onsite"
    relocationCountry: string | null
    employmentType: "direct" | "employer_of_record" | "contract" | null
    rules: StoredRule[]
    eligible: boolean
    normalizedMonthlyMaxUsd: string | null
    fxRateDate: string | null
  }>
  match: Readonly<{
    careerProfileVersion: number
    coveredCount: number
    totalCount: number
    items: StoredMatchItem[]
  }>
  /** null = no technology data (AC 4.8). */
  technologies: readonly StoredTechnology[] | null
  /** ATS key skills; null = none. */
  keySkills?: readonly StoredTechnology[] | null
  /** EPIC-0012 rule 4: verified forward-looking quotes; null or [] stores null. */
  forwardStatements?: readonly string[] | null
  /** ATS fit 0 to 100 against the approved profile; null without posting keywords. */
  atsFit?: number | null
  evaluatedAt: Date
}>

/** The stored Job criteria (EPIC-0004; EPIC-0006 adds the target families and the seniority floor). */
export type StoredJobCriteria = Readonly<{
  minCoreMatchPercent: number
  frameworks: string[]
  technologies: string[]
  /** Catalog order (the PUT stores them that way; unknown stored keys cannot pass the CHECK). */
  targetRoleFamilies: RoleFamilyValue[]
  seniorityFloor: SeniorityFloor
  version: number
}>

/** Steps 4 and 5 of AC 5.1 and the stored Match verdict, decided with the criteria read under lock. */
export type CriteriaVerdict = Readonly<{
  status: "ranked" | "excluded" | "skipped"
  skipReason: string | null
  skipDetail: string | null
  verdict: "strong" | "weak"
  weakReason: string | null
  /** Canonical entries of both lists (match_evidence.criteria_technologies). */
  criteriaTechnologies: string[]
}>

/** A posting as one Candidate sees it: shared facts from `job_posting p`, their own state from `candidate_posting cp`. */
const POSTING_LIST_COLUMNS = [
  "p.id",
  "p.application_url",
  "p.requisition_id",
  "p.apply_url",
  "p.application_system",
  "p.apply_mode",
  "cp.origin",
  "p.employer_board_id",
  "p.remote_board_key",
  "p.attribution_name",
  "p.attribution_url",
  "p.title",
  "p.company",
  "p.posting_text",
  "p.structured",
  "cp.status",
  "cp.skip_reason",
  "cp.skip_detail",
  "cp.evaluation_failure",
  "p.role_family",
  "cp.discovered_at",
  "cp.evaluated_at",
  "p.posted_at",
  "p.posted_date_kind",
  // EPIC-0006: the shared facts the visibility rule reads.
  "p.title_folded",
  "p.prefilter_skip",
  "p.seniority_marker",
] as const

/**
 * Bounds the evaluator's wait for a Job criteria save (architecture "Risks: lock
 * waits in the worker"): 5 s. The evaluator runs in the worker and, for a pasted
 * link, in the api, whose pool statement_timeout is also 5 s; the local 10 s
 * statement bound lets the lock wait end with 55P03, which is retried (QA-G5-2).
 */
export const VERDICT_TIMEOUTS = transactionTimeouts(5_000, 10_000)

/**
 * EPIC-0002 A1: every statement runs in the scope's `CandidateTx`. The
 * Candidate tables (`candidate_posting`, `eligibility_result`,
 * `match_evidence`, `career_profile_version`, `job_criteria`) name
 * `candidate_id`. `job_posting` holds shared posting facts only (item 6); a
 * Candidate's status, skip and evaluation state is their `candidate_posting`
 * row. The board catalog, `evaluation_setting`, `employer_list_state` and
 * `control_state` stay shared until slices B and C; only the Operator reaches
 * them until then.
 */
@Injectable()
export class DiscoveryRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /**
   * Stores a posting once per (application URL, requisition ID) (AC 3.2), then
   * gives the scope's Candidate their `candidate_posting` row, also once:
   * `created` is true only when this call created that Candidate's row, so a
   * posting another Candidate already holds is new to this one (item 6).
   *
   * The pre-filter is a shared fact (architecture r4 "Shared pre-filter",
   * AC 5.17): `runPreFilter` is called only when this call inserts the shared
   * row, and its skip is kept on `job_posting.prefilter_skip`. A Candidate who
   * first sees a stored posting gets that stored skip copied, with no pre-filter
   * and no AI call. A concurrent insert of the same key loses on the unique
   * index and uses the winner's stored facts, so both Candidates agree.
   */
  async storeOnce(posting: NewPosting, runPreFilter: () => PreFilterResult): Promise<StoredForCandidate> {
    return this.tenant.run(async (tx, candidateId) => {
      const shared = await insertPostingOnce(tx, posting, runPreFilter)
      // EPIC-0006 (AC-4.3, AC-7.1): a row that would start "checking" but is hidden for this Candidate starts
      // "not_checked" and is not evaluated. Pre-filter and unsupported-system skips keep their state.
      const ctx = await visibilityContext(tx, candidateId, posting.discoveredAt)
      const visible = hiddenReason(shared.visibility, ctx) === null
      // EPIC-0002 D13 (EPIC-0007 D13, P1-B-01): a row that would wait for evaluation starts "waiting_to_be_checked"
      // and is not evaluated while this Candidate may not have postings evaluated, so the paste answers it at once.
      const allowed = () => identityIn(tx, candidateId).then(evaluationAllowed)
      const initial = startingState(shared.facts, !visible)
      const state: StartingState = initial.status === "checking" && !(await allowed()) ? { ...initial, status: "waiting_to_be_checked" } : initial
      const held = await tx
        .insertInto("candidate_posting")
        .values({
          candidate_id: candidateId,
          job_posting_id: shared.id,
          origin: posting.origin,
          status: state.status,
          skip_reason: state.skipReason,
          skip_detail: state.skipDetail,
          evaluation_failure: null,
          discovered_at: posting.discoveredAt,
          evaluated_at: null,
          // AC-7.12: a row stored as "checking" starts its 15 minutes now (read only while it is "checking").
          checking_since: posting.discoveredAt,
        })
        .onConflict((oc) => oc.columns(["candidate_id", "job_posting_id"]).doNothing())
        .returning("job_posting_id")
        .executeTakeFirst()
      if (held !== undefined) return { id: shared.id, created: true, state, evaluate: state.status === "checking" }
      // AC-5.8: a backfill that makes this Candidate's not_checked row visible claims it for evaluation. Other holders are not queued.
      if (!shared.backfilled || !visible) return { id: shared.id, created: false, state, evaluate: false }
      const evaluate = await allowed()
      const claimed = await claimNotChecked(tx, candidateId, shared.id, evaluate ? "checking" : "waiting_to_be_checked", posting.discoveredAt)
      return { id: shared.id, created: false, state, evaluate: claimed && evaluate }
    })
  }

  /** EPIC-0010: stores a pasted description for the scope Candidate (`pasted-description-store.ts`), one transaction. */
  storePastedDescription(input: PastedDescriptionInput): Promise<PastedDescriptionResult> {
    return this.tenant.run((tx, candidateId) => storePastedDescription(this.tenant, tx, candidateId, input))
  }

  /** EPIC-0002 D13: whether the scope Candidate's postings may be evaluated now (the waiting reason of a paste). */
  evaluationAllowedNow(): Promise<boolean> {
    return this.tenant.run(async (tx, candidateId) => evaluationAllowed(await identityIn(tx, candidateId)))
  }

  findByKey(applicationUrl: string, requisitionId: string) {
    return this.tenant.run((tx) => findPostingIdByKey(tx, applicationUrl, requisitionId))
  }

  /** A pasted URL that matches a posting this Candidate holds, by its application or apply URL, before any network read. */
  findByUrl(applicationUrl: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("job_posting as p")
        .innerJoin("candidate_posting as cp", (join) => join.onRef("cp.job_posting_id", "=", "p.id").on("cp.candidate_id", "=", candidateId))
        .select(["p.id"])
        .where((eb) => eb.or([eb("p.application_url", "=", applicationUrl), eb("p.apply_url", "=", applicationUrl)]))
        .orderBy("cp.discovered_at")
        .executeTakeFirst()
    )
  }

  /** The posting as this Candidate sees it; undefined when they do not hold it (another Candidate's posting is not found). */
  findPosting(id: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("job_posting as p")
        .innerJoin("candidate_posting as cp", (join) => join.onRef("cp.job_posting_id", "=", "p.id").on("cp.candidate_id", "=", candidateId))
        .select(POSTING_LIST_COLUMNS)
        .select(sql<boolean>`p.technologies is null`.as("technologies_missing"))
        .where("p.id", "=", id)
        .executeTakeFirst()
    )
  }

  /**
   * EPIC-0006: one list request in one transaction, so the page, the count,
   * the aggregate and the criteria all see the same Job criteria row and the
   * same visibility context (architecture.r1 "DiscoveryService.listPostings").
   */
  /** EPIC-0002 B1: the hash of the Candidate's current tier map, which the cursor binding covers. */
  currentTierHash(): Promise<string> {
    return this.tenant.run(async (tx, candidateId) => tierMapHash(await tierMapIn(tx, candidateId)))
  }

  /**
   * `tierHash` is the hash the caller decoded the cursor under. The page reads
   * the tier map again in its own transaction; if it changed in between (a
   * save committed), the cursor is stale: `TierMapChangedError`, a 400 like
   * any stale cursor, so a page is never served under one map with a keyset
   * position from another.
   */
  listPage(
    input: Readonly<{ tab: PostingsTabValue; filter: PageFilter; after: PostingKey | null; limit: number; now: Date; tierHash: string }>
  ): Promise<ListPage> {
    return this.tenant.run(async (tx, candidateId) => {
      const row = await criteriaRow(tx, candidateId).executeTakeFirstOrThrow()
      const criteria = criteriaOf(row)
      const tiers = await tierMapIn(tx, candidateId)
      const tierHash = tierMapHash(tiers)
      if (input.after !== null && tierHash !== input.tierHash) throw new TierMapChangedError()
      const after = input.after
      const ctx = await visibilityContext(tx, candidateId, input.now)
      const rows = await readPage(tx, candidateId, { tab: input.tab, filter: input.filter, after, limit: input.limit, ctx, tiers })
      const totalCount = await countMatching(tx, candidateId, input.tab, input.filter, ctx)
      const aggregate = await listAggregate(tx, candidateId, ctx)
      const operator = aggregate.waiting > 0 ? await isOperatorIn(tx, candidateId) : false
      return { rows, totalCount, aggregate, criteria, operator, tierHash }
    })
  }

  /**
   * EPIC-0006 (threat model TM-04): runs one evaluation while this process
   * holds a session advisory lock on (scope Candidate, posting). A second
   * concurrent evaluation of the same pair gets "locked" at once and does
   * nothing, so two jobs never both reach the reservation and the model call.
   */
  exclusiveEvaluation<T>(postingId: string, work: () => Promise<T>): Promise<T | "locked"> {
    return this.tenant.tryWithSessionLock(evaluationLockKey(CandidateScope.require(), postingId), work)
  }

  /**
   * EPIC-0006 Check again (contract "POST /v1/job-postings/check-again"), one
   * transaction for the session Candidate: lock their Job criteria FOR SHARE,
   * claim every visible `evaluation_failed` or `not_checked` row, and (r4,
   * AC-7.13) every visible stuck `checking` row (`stuck.ts`), with
   * `UPDATE ... RETURNING` (the only dedupe; concurrent presses claim disjoint
   * rows), and, for the Operator only, insert one job per claimed row in the
   * same transaction. `evaluation_failure` is left as stored. Any failure
   * rolls back the claim and the jobs.
   */
  async checkAgain(now: Date, enqueue: (trx: CandidateTx, candidateId: string, ids: readonly string[]) => Promise<void>): Promise<{ queued: number; movedTo: "checking" | "waiting_to_be_checked" }> {
    return this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now, "share")
      const movedTo = evaluationAllowed(await identityIn(tx, candidateId)) ? "checking" : "waiting_to_be_checked"
      const claimed = await sql<{ id: string }>`
        update candidate_posting cp set status = ${movedTo}, checking_since = ${now}
        from job_posting p
        where cp.candidate_id = ${candidateId}::uuid and p.id = cp.job_posting_id
          and (cp.status in ('evaluation_failed', 'not_checked') or ${stuckSql("cp", now)}) and ${visibleSql("p", ctx)}
        returning cp.job_posting_id::text as id`.execute(tx)
      const ids = claimed.rows.map((row) => row.id)
      if (movedTo === "checking") await enqueue(tx, candidateId, ids)
      return { queued: ids.length, movedTo }
    })
  }

  /**
   * EPIC-0006 r4 (AC-7.14, AC-7.15, P19; architecture-stuck-checking.md): the
   * scheduled discovery run's recovery for the scope Candidate, in one
   * transaction. Their stuck rows that are hidden go back to the state AC-7.1
   * names (`evaluation_failed` with the stored kind, else `not_checked`), with
   * no job. Their visible stuck rows are claimed (`checking_since = now`, so
   * the 15 minutes restart) and returned for one evaluation job each. A
   * Candidate whose postings are not evaluated yet (D13) gets nothing claimed
   * or returned: only their own Check again recovers them.
   */
  async requeueStuck(now: Date): Promise<{ requeued: string[]; returnedHidden: number }> {
    return this.tenant.run(async (tx, candidateId) => {
      if (!evaluationAllowed(await identityIn(tx, candidateId))) return { requeued: [], returnedHidden: 0 }
      const ctx = await visibilityContext(tx, candidateId, now, "share")
      const hidden = await sql<{ id: string }>`
        update candidate_posting cp set status = case when cp.evaluation_failure is null then 'not_checked' else 'evaluation_failed' end
        from job_posting p
        where cp.candidate_id = ${candidateId}::uuid and p.id = cp.job_posting_id and ${stuckSql("cp", now)} and not ${visibleSql("p", ctx)}
        returning cp.job_posting_id::text as id`.execute(tx)
      const claimed = await sql<{ id: string }>`
        update candidate_posting cp set checking_since = ${now}
        from job_posting p
        where cp.candidate_id = ${candidateId}::uuid and p.id = cp.job_posting_id and ${stuckSql("cp", now)} and ${visibleSql("p", ctx)}
        returning cp.job_posting_id::text as id`.execute(tx)
      return { requeued: claimed.rows.map((row) => row.id), returnedHidden: hidden.rows.length }
    })
  }

  /** Role and state of a Candidate from the identity table (no RLS), for the worker's job check (TM-01). Not scoped. */
  candidateIdentity(candidateId: string) {
    return this.tenant.candidateIdentity(candidateId)
  }

  /** The scope Candidate's visibility context (their `job_criteria` row and the request's WAT date). */
  visibilityContext(now: Date): Promise<VisibilityContext> {
    return this.tenant.run((tx, candidateId) => visibilityContext(tx, candidateId, now))
  }

  ranksOf(ctx: VisibilityContext, ids: readonly string[]): Promise<Map<string, number>> {
    return this.tenant.run(async (tx, candidateId) => ranksOf(tx, candidateId, ctx, await tierMapIn(tx, candidateId), ids))
  }

  /**
   * Postings saved during a cost pause, oldest first (cost-ceiling.feature @r4).
   * EPIC-0006 (AC-7.1, AC-7.4): only the scope Candidate's visible ones; a
   * hidden waiting posting stays waiting.
   */
  async waitingIds(limit: number, now: Date): Promise<string[]> {
    const rows = await this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now)
      return tx
        .selectFrom("candidate_posting as cp")
        .innerJoin("job_posting as p", "p.id", "cp.job_posting_id")
        .select("cp.job_posting_id")
        .where("cp.candidate_id", "=", candidateId)
        .where("cp.status", "=", "waiting_to_be_checked")
        .where(visibleSql("p", ctx))
        .orderBy("cp.discovered_at")
        .orderBy("cp.job_posting_id")
        .limit(limit)
        .execute()
    })
    return rows.map((row) => row.job_posting_id)
  }

  /**
   * v1.24.0 (AA-6.4): the scope Candidate's Application for this posting's
   * requisition (including a minimal record), with what decides whether it is markable.
   */
  findRequisitionApplication(postingId: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .innerJoin("job_posting", (join) =>
          join.onRef("job_posting.application_url", "=", "application.application_url").onRef("job_posting.requisition_id", "=", "application.requisition_id")
        )
        .select(["application.id", "application.submission_state", "application.sample_state", "application.details_deleted_at"])
        .where("application.candidate_id", "=", candidateId)
        .where("job_posting.id", "=", postingId)
        .executeTakeFirst()
    )
  }

  /** `date` columns are read as text so no time zone can shift the day. */
  findEligibility(id: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
      .selectFrom("eligibility_result")
      .selectAll()
      .select((eb) => eb.cast<string | null>("fx_rate_date", "text").as("fx_rate_date"))
      .where("candidate_id", "=", candidateId)
      .where("job_posting_id", "=", id)
      .executeTakeFirst()
    )
  }

  findMatch(id: string) {
    return this.tenant.run((tx, candidateId) => tx.selectFrom("match_evidence").selectAll().where("candidate_id", "=", candidateId).where("job_posting_id", "=", id).executeTakeFirst())
  }

  findMatchCounts(ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([])
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("match_evidence")
        .select(["job_posting_id", "covered_count", "total_count", "threshold", "ats_fit"])
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "in", ids)
        .execute()
    )
  }

  findUnverifiedLabels(ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([])
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("eligibility_result").select(["job_posting_id", "rules"]).where("candidate_id", "=", candidateId).where("job_posting_id", "in", ids).execute()
    )
  }

  /**
   * EPIC-0006 evaluator gate (AC-7.1): the posting's first hidden reason for
   * the scope Candidate, from their committed criteria (a plain read: a save in
   * progress does not block the gate; the verdict transaction serialises with
   * it as before, and AC-7.1 lets an in-flight call record its verdict).
   * When hidden, the row returns to the state the attempt found it in:
   * `checking` with a stored failure kind -> `evaluation_failed` (kind kept),
   * `checking` without one -> `not_checked`; `waiting_to_be_checked` and
   * `evaluation_failed` are left as they are. Undefined: the Candidate holds
   * no such posting.
   */
  async hideIfHidden(id: string, now: Date): Promise<HiddenReason | null | undefined> {
    return this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now)
      const row = await tx
        .selectFrom("job_posting as p")
        .innerJoin("candidate_posting as cp", (join) => join.onRef("cp.job_posting_id", "=", "p.id").on("cp.candidate_id", "=", candidateId))
        .select(["p.title_folded", "p.prefilter_skip", "p.role_family", "p.seniority_marker", "p.posted_at", "p.origin", "cp.status"])
        .where("p.id", "=", id)
        .forUpdate("cp")
        .executeTakeFirst()
      if (!row) return undefined
      const reason = hiddenReason(visibilityFactsOf(row), ctx)
      if (reason !== null && row.status === "checking") {
        await sql`update candidate_posting set status = case when evaluation_failure is null then 'not_checked' else 'evaluation_failed' end
          where candidate_id = ${candidateId}::uuid and job_posting_id = ${id}::uuid and status = 'checking'`.execute(tx)
      }
      return reason
    })
  }

  /**
   * EPIC-0006 (TM-05, CHK-38): when the scope Candidate may not have postings
   * evaluated yet, moves their `checking` row to `waiting_to_be_checked` and
   * returns true; the caller stops before any reservation.
   */
  async deferIfNotAllowed(id: string): Promise<boolean> {
    return this.tenant.run(async (tx, candidateId) => {
      if (evaluationAllowed(await identityIn(tx, candidateId))) return false
      await tx
        .updateTable("candidate_posting")
        .set({ status: "waiting_to_be_checked" })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "=", "checking")
        .execute()
      return true
    })
  }

  /**
   * Moves this Candidate's posting to "checking" from one of `from`; false when it is in any other state.
   * AC-7.12: restarts the 15 minutes (`checking_since = at`); the caller holds the evaluation lock.
   */
  async moveToChecking(id: string, from: readonly JobPostingStatus[], at: Date): Promise<boolean> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("candidate_posting")
        .set({ status: "checking", evaluation_failure: null, checking_since: at })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "in", from)
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows) > 0
  }

  async markFailed(id: string, failure: string, at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("candidate_posting")
        .set({ status: "evaluation_failed", evaluation_failure: failure, evaluated_at: at, evaluation_attempts: sql<number>`evaluation_attempts + 1` })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .execute()
    )
  }

  /**
   * v1.28.1 automatic retry (migration 0036): visible postings whose evaluation failed once for a
   * transient reason, at least `RETRY_BACKOFF_MINUTES` ago, and that the worker has not already
   * retried. Oldest first. The row stays `evaluation_failed` until the retry claims it, so a lost
   * job is picked up by the next tick.
   */
  async retryFailedIds(limit: number, now: Date): Promise<string[]> {
    const rows = await this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now, "share")
      return tx
        .selectFrom("candidate_posting as cp")
        .innerJoin("job_posting as p", "p.id", "cp.job_posting_id")
        .select("cp.job_posting_id")
        .where("cp.candidate_id", "=", candidateId)
        .where("cp.status", "=", "evaluation_failed")
        .where("cp.evaluation_attempts", "<", RETRY_ATTEMPTS_LIMIT)
        .where("cp.evaluation_failure", "in", [...RETRYABLE_FAILURES])
        .where("cp.evaluated_at", "is not", null)
        .where("cp.evaluated_at", "<=", new Date(now.getTime() - RETRY_BACKOFF_MINUTES * 60_000))
        .where(visibleSql("p", ctx))
        .orderBy("cp.evaluated_at")
        .orderBy("cp.job_posting_id")
        .limit(limit)
        .execute()
    })
    return rows.map((row) => row.job_posting_id)
  }

  async markWaiting(id: string): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx.updateTable("candidate_posting").set({ status: "waiting_to_be_checked" }).where("candidate_id", "=", candidateId).where("job_posting_id", "=", id).execute()
    )
  }

  /**
   * The evaluator's cost-pause step, before it claims the row: moves this Candidate's posting to
   * "waiting_to_be_checked" only from a state an evaluation may claim (the `moveToChecking` set). EPIC-0006 r4
   * (AC-7.16): a duplicate job (stuck re-queues send no singletonKey) for a posting that already has a verdict
   * changes nothing, even during the cost pause.
   */
  async markWaitingIfClaimable(id: string): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("candidate_posting")
        .set({ status: "waiting_to_be_checked" })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "in", ["checking", "waiting_to_be_checked", "evaluation_failed"])
        .execute()
    )
  }

  /**
   * Writes the evaluation in one transaction: eligibility_result, match_evidence
   * and the posting's status (EPIC-0004 AC 5.6, 5.10). The Job criteria row is
   * read FOR SHARE inside that transaction, after the model call, and `decide`
   * applies them. A save holds FOR UPDATE while it re-decides, so whichever
   * commits second sees the other: no verdict outlives superseded criteria. A
   * lock timeout is retried once; the model result is already in memory.
   */
  async recordEvaluation(
    id: string,
    record: EvaluationRecord,
    decide: (criteria: StoredJobCriteria) => CriteriaVerdict
  ): Promise<StoredJobCriteria> {
    try {
      return await this.recordEvaluationOnce(id, record, decide)
    } catch (error) {
      if (!isLockTimeout(error)) throw error
      return this.recordEvaluationOnce(id, record, decide)
    }
  }

  private async recordEvaluationOnce(
    id: string,
    record: EvaluationRecord,
    decide: (criteria: StoredJobCriteria) => CriteriaVerdict
  ): Promise<StoredJobCriteria> {
    return this.tenant.run(async (trx, candidateId) => {
      await applyTransactionTimeouts(trx, VERDICT_TIMEOUTS)
      // EPIC-0002 B1 (R6-AC4, AC 5.10 widening, lock order): the current preferences FOR SHARE, then the criteria FOR SHARE.
      const preferences = await sharePreferences(trx, candidateId)
      const row = await criteriaRow(trx, candidateId).forShare().executeTakeFirstOrThrow()
      const criteria = criteriaOf(row)
      const decided = decide(criteria)
      // Steps 2 and 3 under the current version, with the family this evaluation reconciles to. They win over
      // Eligibility and Match (R6-2 order); the Eligibility result computed at the start is stored as is (r4 AC 4.23).
      const facts = await trx.selectFrom("job_posting").select(["role_family", "title_folded"]).where("id", "=", id).executeTakeFirstOrThrow()
      const preferenceSkip = decidePreferenceSkip(preferences?.values ?? null, {
        roleFamily: reconcileRoleFamily(storedFamily(facts.role_family), record.roleFamily),
        titleFolded: facts.title_folded,
      })
      const verdict: CriteriaVerdict = preferenceSkip === null ? decided : { ...decided, status: "skipped", skipReason: preferenceSkip, skipDetail: null }
      const eligibility = {
        arrangement: record.eligibility.arrangement,
        relocation_country: record.eligibility.relocationCountry,
        employment_type: record.eligibility.employmentType,
        rules: JSON.stringify(record.eligibility.rules),
        eligible: record.eligibility.eligible,
        normalized_monthly_max_usd: record.eligibility.normalizedMonthlyMaxUsd,
        fx_rate_date: record.eligibility.fxRateDate,
        evaluated_at: record.evaluatedAt,
      }
      await trx
        .insertInto("eligibility_result")
        .values({ candidate_id: candidateId, job_posting_id: id, ...eligibility })
        .onConflict((oc) => oc.columns(["candidate_id", "job_posting_id"]).doUpdateSet(eligibility))
        .execute()
      const match = {
        career_profile_version: record.match.careerProfileVersion,
        verdict: verdict.verdict,
        weak_reason: verdict.weakReason,
        covered_count: record.match.coveredCount,
        total_count: record.match.totalCount,
        threshold: (criteria.minCoreMatchPercent / 100).toFixed(3),
        items: JSON.stringify(record.match.items),
        evaluated_at: record.evaluatedAt,
        criteria_version: criteria.version,
        criteria_technologies: verdict.criteriaTechnologies,
        ats_fit: record.atsFit ?? null,
      }
      await trx
        .insertInto("match_evidence")
        .values({ candidate_id: candidateId, job_posting_id: id, ...match })
        .onConflict((oc) => oc.columns(["candidate_id", "job_posting_id"]).doUpdateSet(match))
        .execute()
      await trx
        .updateTable("candidate_posting")
        .set({
          status: verdict.status,
          skip_reason: verdict.skipReason,
          skip_detail: verdict.skipDetail,
          evaluation_failure: null,
          evaluated_at: record.evaluatedAt,
          preferences_version: preferenceSkip === null ? record.preferencesVersion : (preferences?.version ?? 0),
        })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .execute()
      // Role family and technologies are facts about the posting, shared by every Candidate (r4).
      // EPIC-0006 AC-1.8 (CR-1): the evaluation moves the stored family only between technical lead and people
      // management; an untitled posting (stored null) takes it. The row lock is taken here, where the update below
      // took it before, so the lock order is unchanged and a concurrent evaluation reconciles against this result.
      const current = await trx.selectFrom("job_posting").select("role_family").where("id", "=", id).forUpdate().executeTakeFirstOrThrow()
      await trx
        .updateTable("job_posting")
        .set({ role_family: reconcileRoleFamily(storedFamily(current.role_family), record.roleFamily), technologies: record.technologies === null ? null : JSON.stringify(record.technologies), ats_skills: record.keySkills ? JSON.stringify(record.keySkills) : null, forward_statements: record.forwardStatements && record.forwardStatements.length > 0 ? JSON.stringify(record.forwardStatements) : null })
        .where("id", "=", id)
        .execute()
      return criteria
    })
  }

  /**
   * EPIC-0002 B1 steps 2 and 3 before any paid work (R6-2: no AI call, no
   * reservation). Reads the current preferences and the posting's stored
   * family and folded title; when either rule skips, records `skipped` with
   * the reason, `skip_detail` null and `preferences_version`, and returns the
   * reason. Only a row this attempt holds in `checking` is written. Returns
   * null (writes nothing) when both rules pass or there is no record.
   */
  async skipByPreferences(id: string, at: Date): Promise<PreferenceSkipReason | null> {
    return this.tenant.run(async (trx, candidateId) => {
      const preferences = await readPreferences(trx, candidateId)
      if (preferences === null) return null
      const facts = await trx.selectFrom("job_posting").select(["role_family", "title_folded"]).where("id", "=", id).executeTakeFirst()
      if (!facts) return null
      const reason = decidePreferenceSkip(preferences.values, { roleFamily: facts.role_family, titleFolded: facts.title_folded })
      if (reason === null) return null
      const updated = await trx
        .updateTable("candidate_posting")
        .set({ status: "skipped", skip_reason: reason, skip_detail: null, evaluation_failure: null, evaluated_at: at, preferences_version: preferences.version })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "=", "checking")
        .executeTakeFirst()
      return Number(updated.numUpdatedRows) > 0 ? reason : null
    })
  }

  /**
   * EPIC-0002 B1: the evaluated Candidate's Eligibility preferences and their
   * version, read once at the start of an evaluation (r1 E4). No record (an
   * invitee before wizard step 3): `STEP3_DEFAULTS` and version 0, so every
   * rule still has a defined result.
   */
  readEligibilityPreferences(): Promise<Readonly<{ version: number; preferences: EligibilityPreferences }>> {
    return this.tenant.run(async (trx, candidateId) => {
      const stored = await readPreferences(trx, candidateId)
      return stored === null
        ? { version: 0, preferences: eligibilityPreferencesOf(STEP3_DEFAULTS) }
        : { version: stored.version, preferences: eligibilityPreferencesOf(stored.values) }
    })
  }

  /** The current Job criteria, without a lock (read path). */
  async readCriteria(): Promise<StoredJobCriteria> {
    return criteriaOf(await this.tenant.run((tx, candidateId) => criteriaRow(tx, candidateId).executeTakeFirstOrThrow()))
  }

  /**
   * The verified technologies of one posting; null = no technology data.
   * SEC-011 (AC 5.11): only `{ name: string, quote: string }` entries are
   * returned. Anything else stored is dropped, so the detail never fails on it.
   */
  async findTechnologies(id: string): Promise<StoredTechnology[] | null> {
    const row = await this.tenant.run((tx) => tx.selectFrom("job_posting").select("technologies").where("id", "=", id).executeTakeFirst())
    return wellFormedTechnologies(row?.technologies ?? null)
  }

  // Settings, pauses and Job Sources.

  readControl() {
    return this.tenant.run((tx) => tx.selectFrom("control_state").selectAll().executeTakeFirstOrThrow())
  }

  /** The hours rule settings. The minimum core Match lives in `job_criteria` (EPIC-0004 AC 2.4, 7.2). */
  async readSettings(): Promise<{ hoursCutoff: string; hoursTimeZone: string }> {
    const row = await this.tenant.run((tx) => tx.selectFrom("evaluation_setting").select(["hours_cutoff", "hours_time_zone"]).executeTakeFirstOrThrow())
    return { hoursCutoff: row.hours_cutoff, hoursTimeZone: row.hours_time_zone }
  }

  readEmployerListState() {
    return this.tenant.run((tx) => tx.selectFrom("employer_list_state").selectAll().executeTakeFirstOrThrow())
  }

  /** Idempotent: the first approval time is kept. */
  async approveEmployerList(at: Date): Promise<void> {
    await this.tenant.run((tx) => tx.updateTable("employer_list_state").set({ approved_at: sql`coalesce(approved_at, ${at})` }).execute())
  }

  listEmployerBoards() {
    return this.tenant.run((tx) => tx.selectFrom("employer_board").selectAll().orderBy("position").execute())
  }

  listRemoteBoards() {
    return this.tenant.run((tx) =>
      tx
        .selectFrom("remote_board")
        .selectAll()
        .select((eb) => eb.cast<string | null>("verified_on", "text").as("verified_on"))
        .orderBy("position")
        .execute()
    )
  }

  findRemoteBoard(key: string) {
    return this.tenant.run((tx) =>
      tx
        .selectFrom("remote_board")
        .selectAll()
        .select((eb) => eb.cast<string | null>("verified_on", "text").as("verified_on"))
        .where("key", "=", key as RemoteBoardKey)
        .executeTakeFirst()
    )
  }

  async verifyRemoteBoard(key: RemoteBoardKey, verifiedOn: string, basis: string): Promise<void> {
    await this.tenant.run((tx) => tx.updateTable("remote_board").set({ verified_on: verifiedOn, verification_basis: basis }).where("key", "=", key).execute())
  }

  async setRemoteBoardEnabled(key: RemoteBoardKey, enabled: boolean): Promise<void> {
    await this.tenant.run((tx) => tx.updateTable("remote_board").set({ enabled }).where("key", "=", key).execute())
  }

  /**
   * Claims today's read of a board: true only if it was not read since `since`
   * (start of today in Africa/Lagos). Enforces "at most once a day per board".
   */
  async claimBoardRead(table: "employer_board" | "remote_board", id: string, since: Date, at: Date): Promise<boolean> {
    const result =
      table === "employer_board"
        ? await this.tenant.run((tx) =>
          tx
              .updateTable("employer_board")
              .set({ last_read_at: at })
              .where("id", "=", id)
              .where((eb) => eb.or([eb("last_read_at", "is", null), eb("last_read_at", "<", since)]))
              .executeTakeFirst()
          )
        : await this.tenant.run((tx) =>
          tx
              .updateTable("remote_board")
              .set({ last_read_at: at })
              .where("key", "=", id as RemoteBoardKey)
              .where((eb) => eb.or([eb("last_read_at", "is", null), eb("last_read_at", "<", since)]))
              .executeTakeFirst()
          )
    return Number(result.numUpdatedRows) > 0
  }

  approvedFacts() {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst()
    )
  }
}

/** `visibility`: the shared facts after any backfill. `backfilled`: this call wrote the posted date onto an existing undated row. */
type SharedPosting = Readonly<{ id: string; facts: SharedPostingFacts; visibility: VisibilityFacts; backfilled: boolean }>

/**
 * The shared posting for this requisition key: the stored row's facts when it
 * exists (no pre-filter), else a new row whose `prefilter_skip` comes from one
 * `runPreFilter` call. A lost race reads the winner's facts; the loser's
 * pre-filter result is discarded, so the stored fact stays the only one.
 */
async function insertPostingOnce(tx: CandidateTx, posting: NewPosting, runPreFilter: () => PreFilterResult): Promise<SharedPosting> {
  const stored = await findSharedFacts(tx, posting.applicationUrl, posting.requisitionId)
  if (stored) return backfillPostedDate(tx, stored, posting)
  const filter = runPreFilter()
  const prefilterSkip = filter.pass ? null : filter.reason
  const titleFolded = posting.title === null || posting.title.trim() === "" ? null : foldForKeywords(posting.title)
  // EPIC-0006 (AC-1.8): family from the title at first store, when titled and past the pre-filter; marker when titled.
  const roleFamily = titleFolded !== null && prefilterSkip === null ? classifyTitle(posting.title ?? "") : null
  const marker = seniorityMarker(posting.title)
  const inserted = await tx
    .insertInto("job_posting")
    .values({
      id: randomUUID(),
      application_url: posting.applicationUrl,
      requisition_id: posting.requisitionId,
      apply_url: posting.applyUrl,
      application_system: posting.applicationSystem,
      apply_mode: posting.applyMode,
      origin: posting.origin,
      employer_board_id: posting.employerBoardId,
      remote_board_key: posting.remoteBoardKey,
      attribution_name: posting.attribution?.name ?? null,
      attribution_url: posting.attribution?.url ?? null,
      title: posting.title,
      title_folded: titleFolded,
      company: posting.company,
      posting_text: posting.postingText,
      structured: JSON.stringify(posting.structured),
      role_family: roleFamily,
      discovered_at: posting.discoveredAt,
      prefilter_skip: prefilterSkip,
      posted_at: posting.postedAt,
      posted_date_kind: posting.postedAt === null ? null : posting.postedDateKind,
      seniority_marker: marker,
    })
    .onConflict((oc) => oc.columns(["application_url", "requisition_id"]).doNothing())
    .returning("id")
    .executeTakeFirst()
  if (inserted) {
    return {
      id: inserted.id,
      facts: { prefilterSkip, applyMode: posting.applyMode, applicationSystem: posting.applicationSystem },
      visibility: { titled: titleFolded !== null, prefilterSkip, roleFamily, seniorityMarker: marker, postedAt: posting.postedAt, pastedDescription: false },
      backfilled: false,
    }
  }
  const winner = await findSharedFacts(tx, posting.applicationUrl, posting.requisitionId)
  if (!winner) throw new Error("Job Posting vanished after a conflicting insert")
  return backfillPostedDate(tx, winner, posting)
}

/**
 * EPIC-0006 backfill (AC-5.6): an existing undated row gets the posted date this
 * read found; a stored date is never overwritten and nothing else changes. The
 * date is shared, so it serves every holder at once.
 */
async function backfillPostedDate(tx: CandidateTx, stored: SharedPosting, posting: NewPosting): Promise<SharedPosting> {
  if (posting.postedAt === null || posting.postedDateKind === null || stored.visibility.postedAt !== null) return stored
  const updated = await tx
    .updateTable("job_posting")
    .set({ posted_at: posting.postedAt, posted_date_kind: posting.postedDateKind })
    .where("id", "=", stored.id)
    .where("posted_at", "is", null)
    .returning(["posted_at"])
    .executeTakeFirst()
  if (!updated) return stored
  return { ...stored, visibility: { ...stored.visibility, postedAt: updated.posted_at }, backfilled: true }
}

/** AC-5.8: this Candidate's `not_checked` row to `checking`; false when it is in any other state. */
async function claimNotChecked(tx: CandidateTx, candidateId: string, id: string, to: "checking" | "waiting_to_be_checked", at: Date): Promise<boolean> {
  const result = await tx
    .updateTable("candidate_posting")
    .set({ status: to, checking_since: at })
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", id)
    .where("status", "=", "not_checked")
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

async function findSharedFacts(tx: CandidateTx, applicationUrl: string, requisitionId: string): Promise<SharedPosting | undefined> {
  const row = await tx
    .selectFrom("job_posting")
    .select(["id", "prefilter_skip", "apply_mode", "application_system", "title_folded", "role_family", "seniority_marker", "posted_at", "origin"])
    .where("application_url", "=", applicationUrl)
    .where("requisition_id", "=", requisitionId)
    .executeTakeFirst()
  return (
    row && {
      id: row.id,
      facts: { prefilterSkip: row.prefilter_skip, applyMode: row.apply_mode, applicationSystem: row.application_system },
      visibility: visibilityFactsOf(row),
      backfilled: false,
    }
  )
}

/** A 48-bit advisory lock key for (Candidate, posting); a collision only serialises two unrelated evaluations. */
/** A stored `job_posting.role_family`, as a catalog key; null when none (untitled, or a value outside the catalog). */
function storedFamily(value: string | null): RoleFamilyValue | null {
  const parsed = roleFamilySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function evaluationLockKey(candidateId: string, postingId: string): number {
  const digest = createHash("sha256").update(`eve/evaluate/${candidateId}/${postingId}`).digest()
  return digest.readUIntBE(0, 6) % 2 ** 52
}

/** Role and state of the scope Candidate, inside their transaction (the identity table has no RLS). */
function identityIn(tx: CandidateTx, candidateId: string) {
  return tx.selectFrom("candidate").select(["role", "state"]).where("id", "=", candidateId).executeTakeFirst()
}

/** The Operator check, from the identity table inside the session's scope. */
async function isOperatorIn(tx: CandidateTx, candidateId: string): Promise<boolean> {
  const row = await tx.selectFrom("candidate").select("role").where("id", "=", candidateId).executeTakeFirst()
  return row?.role === "operator"
}

function findPostingIdByKey(tx: CandidateTx, applicationUrl: string, requisitionId: string) {
  return tx.selectFrom("job_posting").select(["id"]).where("application_url", "=", applicationUrl).where("requisition_id", "=", requisitionId).executeTakeFirst()
}

/** The Candidate's one `job_criteria` row (EPIC-0002 A1: keyed by `candidate_id`, RLS-backed). */
export function criteriaRow(tx: CandidateTx, candidateId: string) {
  return tx.selectFrom("job_criteria").selectAll().where("candidate_id", "=", candidateId)
}

export function criteriaOf(
  row: Readonly<{ min_core_match_percent: number; frameworks: string[]; technologies: string[]; target_role_families: string[]; seniority_floor: SeniorityFloor; version: number }>
): StoredJobCriteria {
  return {
    minCoreMatchPercent: row.min_core_match_percent,
    frameworks: row.frameworks,
    technologies: row.technologies,
    targetRoleFamilies: roleFamilySchema.options.filter((family) => row.target_role_families.includes(family)),
    seniorityFloor: row.seniority_floor,
    version: row.version,
  }
}

/** Keeps stored entries shaped `{ name: string, quote: string }`; a stored non-array is data that mentions nothing. */
export function wellFormedTechnologies(stored: unknown): StoredTechnology[] | null {
  if (stored === null) return null
  if (!Array.isArray(stored)) return []
  return stored.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return []
    const { name, quote } = entry as Record<string, unknown>
    return typeof name === "string" && typeof quote === "string" ? [{ name, quote }] : []
  })
}

/** Moved to `db/transaction-timeouts.ts` (EPIC-0005 r4); re-exported for existing callers. */
export { isLockTimeout }
