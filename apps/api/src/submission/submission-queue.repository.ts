import { sql } from "../db/sql.js"

import type { QueuedPostingDroppedDetail } from "@eve/contracts"

import type { TenantDatabase } from "../db/tenant-database.js"
import { tierMapIn } from "../discovery/tier-map.js"
import { readPreferences } from "../preferences/preferences-read.js"
import { eligibilityPreferencesOf } from "../discovery/rules/eligibility.js"
import { visibilityFactsOf } from "../discovery/discovery.repository.js"
import { hiddenReason, visibilityContext } from "../discovery/visibility.js"
import { dropDetail } from "../documents/override.js"
import { postingState } from "../documents/override-reader.js"
import { addedFactsDropDetail, confirmationRequired, documentsStale } from "../added-facts/added-facts-gate.js"
import { recordedDocuments, toRecordedAddedFacts } from "../added-facts/document-records.js"
import { readApplicationMatch } from "../added-facts/match-read.js"
import { recheckEligibility } from "./eligibility-recheck.js"
import { type Db, cid, shareCriteria, writeEvent } from "./submission-attempts.repository.js"

/**
 * Skip reasons B1 added from the Candidate's Job Preferences (EPIC-0002 B1 "Drop event", narrowed by D47,
 * 2026-10-31): a keyword skip and an excluded role family. `weak_core_match`, `technology_mismatch` and an
 * Eligibility exclusion keep `queued_posting_dropped` (contract v1.24.0, apply-anyway.feature :418).
 */
const PREFERENCES_SKIP_REASONS: ReadonlySet<string> = new Set(["excluded_role_family", "keyword_mismatch"])

/** D47: a posting no longer ranked because of a skip B1 added (keyword or excluded role family). */
export function isRulesDrop(status: string, skipReason: string | null): boolean {
  return status === "skipped" && skipReason !== null && PREFERENCES_SKIP_REASONS.has(skipReason)
}

/**
 * The queued-Application rules and the sample returns: what may be submitted,
 * and why a queued Application is dropped.
 *
 * Every statement runs in the scope's Candidate's `CandidateTx` and names its
 * `candidate_id`; methods that take a `trx` run inside the caller's `run`
 * transaction.
 */
export class SubmissionQueueRepository {
  constructor(
    private readonly tenant: TenantDatabase,
    /** FEAT-0017: the added-facts flag, read once by the owning repository. */
    private readonly addedFactsEnabled: boolean
  ) {}

  /** Queued Applications with their ranking inputs, and the Candidate's tier map (EPIC-0002 B1), read in one transaction. */
  queuedForRanking() {
    return this.tenant.run(async (tx, candidateId) => ({
      tiers: await tierMapIn(tx, candidateId),
      rows: await tx
        .selectFrom("application")
        .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
        .innerJoin("candidate_posting", (join) => join.onRef("candidate_posting.job_posting_id", "=", "job_posting.id").on("candidate_posting.candidate_id", "=", candidateId))
        .leftJoin("match_evidence", (join) => join.onRef("match_evidence.job_posting_id", "=", "job_posting.id").on("match_evidence.candidate_id", "=", candidateId))
        .select([
        "application.id",
        "job_posting.id as job_posting_id",
        "job_posting.role_family",
        "candidate_posting.discovered_at",
        "candidate_posting.origin",
        "match_evidence.covered_count",
        "match_evidence.total_count",
      ])
      // Not filtered on posting status: a queued posting that is no longer ranked is dropped by `submit`.
      .where("application.candidate_id", "=", candidateId)
      .where("application.submission_state", "=", "queued")
      .limit(500)
      .execute(),
    }))
  }

  /**
   * AA-2.5, D8 (amends EPIC-0004 AC 5.8): a queued automatic Application whose
   * posting is not submittable returns to documents ready, not queued. Documents,
   * answers, form read, `override_*` and `marked_not_submitted_at` are kept. One
   * drop event with the drop `detail` (contract drop table). EPIC-0002 B1 (r6
   * "Drop event"): the event kind is `queued_posting_preferences_changed` when
   * the Candidate's rules caused the drop (`eligibilityChanged`, or `dropKind`),
   * else `queued_posting_dropped`.
   */
  async dropQueued(applicationId: string, detail: QueuedPostingDroppedDetail, at: Date, db?: Db, eligibilityChanged = false): Promise<void> {
    const drop = async (tx: Db, candidateId: string) => {
      const result = await tx
        .updateTable("application")
        .set({ submission_state: null, submission_kind: null, queued_for_local_day: null, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        .where("submission_state", "=", "queued")
        .executeTakeFirst()
      if (Number(result.numUpdatedRows) === 1) await writeEvent(this.tenant, applicationId, await this.dropKind(tx, applicationId, detail, eligibilityChanged), detail, at, tx)
    }
    await (db ? drop(db, cid()) : this.tenant.run(drop))
  }

  /**
   * The unlocked early check (`submit`): the drop detail when the queued
   * Application's posting is not submittable, else null. The claim repeats it
   * under the criteria share lock.
   */
  async dropDetailUnlocked(applicationId: string, at: Date): Promise<QueuedPostingDroppedDetail | null> {
    return this.tenant.run((trx) => this.dropDetail(trx, applicationId, at))
  }

  /**
   * SEC-014 (AC 5.8): the pre-submission status check, made atomic. Under the
   * Job criteria share lock, a queued automatic Application whose posting is
   * no longer ranked for the scope's Candidate is dropped exactly as the
   * unlocked check drops it. True when it was dropped. Runs after the browser
   * lease is held and before any page opens; `claim` repeats it for the time
   * the page is open.
   */
  async dropQueuedUnlessRanked(applicationId: string, at: Date): Promise<boolean> {
    return this.tenant.run(async (trx, candidateId) => {
      await shareCriteria(trx)
      const app = await trx.selectFrom("application").select("submission_state").where("candidate_id", "=", candidateId).where("id", "=", applicationId).forUpdate().executeTakeFirst()
      if (app?.submission_state !== "queued") return false
      return this.dropUnlessSubmittable(trx, applicationId, at)
    })
  }

  /**
   * Drops the queued Application, in `trx`, when its posting is not submittable
   * for the scope's Candidate. Call under the criteria share lock.
   */
  async dropUnlessSubmittable(trx: Db, applicationId: string, at: Date): Promise<boolean> {
    const drop = await this.dropOf(trx, applicationId, at)
    if (drop === null) return false
    await this.dropQueued(applicationId, drop.detail, at, trx, drop.eligibilityChanged)
    return true
  }

  /**
   * v1.24.0 "submittable" (AA-2.3, AA-2.4, N1), the test of the three checks:
   * the posting is visible for the scope's Candidate at `at` and either ranked,
   * or the Application's recorded override applies (its stored decision equals
   * the current one). A bare legacy `candidate_override_at` never makes a
   * non-ranked posting submittable (AA-2.7). Null when submittable, else the
   * drop detail. A missing `candidate_posting` row is not submittable
   * (fail-closed). Call under the criteria share lock for the locked checks
   * (the visibility context and the decision are read in `trx`).
   */
  private async dropDetail(trx: Db, applicationId: string, at: Date): Promise<QueuedPostingDroppedDetail | null> {
    const candidateId = cid()
    const app = await trx
      .selectFrom("application")
      .select(["id", "requisition_id", "job_posting_id", "added_facts_version", "added_facts_confirmed_version", "candidate_override_at", "override_created_at", "override_status", "override_skip_reason", "override_skip_detail", "override_violated_rules", "details_deleted_at"])
      .where("candidate_id", "=", candidateId)
      .where("id", "=", applicationId)
      .executeTakeFirst()
    if (!app) return "not_ranked"
    const state = await postingState(trx, candidateId, app.job_posting_id, at)
    const base = dropDetail(app, state)
    // FEAT-0017: stale documents first, then the confirmation and the lift basis (both flag-gated) — one rule, shared
    // with `queue`, `sample`, `sample/approve`, `requeueAtsHeld` and the view.
    const documents = await recordedDocuments(trx, candidateId, applicationId)
    const match = this.addedFactsEnabled && state !== null && state.decision.status !== "ranked" ? await readApplicationMatch(trx, candidateId, app, at) : null
    return addedFactsDropDetail({
      flagOn: this.addedFactsEnabled,
      applicationVersion: app.added_facts_version,
      confirmedVersion: app.added_facts_confirmed_version,
      documents: toRecordedAddedFacts(documents),
      postingStatus: state?.decision.status ?? "checking",
      baseDrop: base,
      match,
    })
  }

  /** FEAT-0017: the stale-documents rule for `queue`, `sample` and `sample/approve` (both flag states, A-11 r1). */
  async addedFactsDocumentsStale(trx: Db, applicationId: string): Promise<boolean> {
    const candidateId = cid()
    const app = await trx.selectFrom("application").select(["added_facts_version"]).where("candidate_id", "=", candidateId).where("id", "=", applicationId).executeTakeFirst()
    if (!app) return false
    const documents = await recordedDocuments(trx, candidateId, applicationId)
    return documentsStale({ flagOn: this.addedFactsEnabled, applicationVersion: app.added_facts_version, documents: toRecordedAddedFacts(documents) })
  }

  /**
   * FEAT-0017 `POST …/queue` refusals after the existing ones: `documents_stale`
   * (both flag states) and `added_facts_confirmation_required` (flag on, lifted,
   * not confirmed for the current counter).
   */
  async addedFactsQueueRefusal(trx: Db, applicationId: string, at: Date): Promise<"documents_stale" | "added_facts_confirmation_required" | null> {
    const candidateId = cid()
    const app = await trx
      .selectFrom("application")
      .select(["id", "requisition_id", "job_posting_id", "added_facts_version", "added_facts_confirmed_version", "details_deleted_at"])
      .where("candidate_id", "=", candidateId)
      .where("id", "=", applicationId)
      .executeTakeFirst()
    if (!app) return null
    const documents = await recordedDocuments(trx, candidateId, applicationId)
    if (documentsStale({ flagOn: this.addedFactsEnabled, applicationVersion: app.added_facts_version, documents: toRecordedAddedFacts(documents) })) return "documents_stale"
    if (!this.addedFactsEnabled) return null
    const match = await readApplicationMatch(trx, candidateId, app, at)
    return confirmationRequired({ flagOn: true, applicationVersion: app.added_facts_version, confirmedVersion: app.added_facts_confirmed_version, match }) ? "added_facts_confirmation_required" : null
  }

  /**
   * The locked checks' drop decision: v1.24.0 "submittable" (`dropDetail`), then
   * the EPIC-0002 B1 Eligibility re-check (r4 :426, R6-AC13, `:695`). Null when
   * the Application may be submitted.
   *
   * B1: every submittable Application is re-checked against the Candidate's current Eligibility preferences (read under the
   * share lock the caller holds). A rule the stored result had not violated and
   * the current version now violates drops it as `eligibilityChanged`, which
   * logs `queued_posting_preferences_changed` with detail `not_ranked` (merge of
   * main 0422b14: the posting's rules no longer rank it for the Candidate). The
   * re-check runs from stored facts only (posting text, board fields, the
   * stored arrangement, relocation country and employment type, and the stored
   * rule quotes): no model call. A rule that becomes Unverified does not drop
   * it. A recorded override (or a legacy `candidate_override_at`) never skips
   * the re-check (architecture r6 CR-B1-02): a v1.24.0 override never covers an
   * Eligibility violation.
   */
  async dropOf(trx: Db, applicationId: string, at: Date): Promise<{ detail: QueuedPostingDroppedDetail; eligibilityChanged: boolean } | null> {
    const detail = await this.dropDetail(trx, applicationId, at)
    if (detail !== null) return { detail, eligibilityChanged: false }
    return (await this.eligibilityNewlyViolated(trx, applicationId, at)) ? { detail: "not_ranked", eligibilityChanged: true } : null
  }

  /** B1 re-check (see `dropOf`): true when the current Eligibility preferences violate a rule the stored result had not. */
  private async eligibilityNewlyViolated(trx: Db, applicationId: string, at: Date): Promise<boolean> {
    const candidateId = cid()
    const posting = await trx
      .selectFrom("application")
      .innerJoin("job_posting as p", "p.id", "application.job_posting_id")
      .leftJoin("eligibility_result as e", (join) => join.onRef("e.job_posting_id", "=", "application.job_posting_id").on("e.candidate_id", "=", candidateId))
      .select([
        "p.title",
        "p.posting_text",
        "p.structured",
        "e.arrangement",
        "e.relocation_country",
        "e.employment_type",
        "e.rules",
      ])
      .where("application.candidate_id", "=", candidateId)
      .where("application.id", "=", applicationId)
      .executeTakeFirst()
    // A missing posting returns false: the status check (`dropDetail`) already drops that case.
    if (!posting) return false
    if (posting.rules === null || posting.arrangement === null) return false
    const preferences = await readPreferences(trx, candidateId)
    if (preferences === null) return false
    const newlyViolated = recheckEligibility(
      { title: posting.title, postingText: posting.posting_text, structured: posting.structured, arrangement: posting.arrangement, relocationCountry: posting.relocation_country, employmentType: posting.employment_type, rules: posting.rules },
      eligibilityPreferencesOf(preferences.values),
      at
    )
    return newlyViolated.length > 0
  }

  /**
   * EPIC-0002 B1 (architecture.r6 "Drop event", R6-AC13, narrowed by D47):
   * why the posting is no longer ranked. Only the causes B1 added (a failed
   * Eligibility re-check, a keyword skip, an excluded role family) log
   * `queued_posting_preferences_changed`; anything else, `weak_core_match`,
   * `technology_mismatch` and an exclusion included, keeps
   * `queued_posting_dropped`. Merge with main 0422b14: the v1.24.0 `detail`
   * decides first, so a closed or hidden posting (B1 "closed, hidden") and an
   * override that no longer applies (the Candidate chose to apply despite the
   * rules) always log `queued_posting_dropped`; only a `not_ranked` drop is
   * classified by the posting's status and skip reason.
   */
  async dropKind(trx: Db, applicationId: string, detail: QueuedPostingDroppedDetail, eligibilityChanged: boolean): Promise<"queued_posting_preferences_changed" | "queued_posting_dropped"> {
    if (eligibilityChanged) return "queued_posting_preferences_changed"
    if (detail !== "not_ranked") return "queued_posting_dropped"
    const candidateId = cid()
    const row = await trx
      .selectFrom("application")
      .innerJoin("candidate_posting", (join) => join.onRef("candidate_posting.job_posting_id", "=", "application.job_posting_id").on("candidate_posting.candidate_id", "=", candidateId))
      .select(["candidate_posting.status", "candidate_posting.skip_reason"])
      .where("application.candidate_id", "=", candidateId)
      .where("application.id", "=", applicationId)
      .executeTakeFirst()
    return row !== undefined && isRulesDrop(row.status, row.skip_reason) ? "queued_posting_preferences_changed" : "queued_posting_dropped"
  }

  /**
   * v1.27.0 (EPIC-0010 PD-4.1): the Application's posting has `apply_mode = 'manual'`, or it was made from a
   * pasted description (synthetic `pasted:` requisition, manual even after its posting is gone).
   */
  async manualOnly(trx: Db, app: Readonly<{ job_posting_id: string; requisition_id: string }>): Promise<boolean> {
    if (app.requisition_id.startsWith("pasted:")) return true
    const posting = await trx.selectFrom("job_posting").select("apply_mode").where("id", "=", app.job_posting_id).executeTakeFirst()
    return posting?.apply_mode === "manual"
  }

  /**
   * EPIC-0006 (AC-3.9): the posting is hidden for `candidateId` at `at`, with
   * the visibility context read from their criteria row FOR SHARE in `trx`. A
   * posting they do not hold reads as hidden (fail-closed).
   */
  async postingHiddenFor(trx: Db, candidateId: string, postingId: string, at: Date): Promise<boolean> {
    const ctx = await visibilityContext(trx, candidateId, at, "share")
    const posting = await trx
      .selectFrom("job_posting as p")
      .innerJoin("candidate_posting as cp", (join) => join.onRef("cp.job_posting_id", "=", "p.id").on("cp.candidate_id", "=", candidateId))
      .select(["p.title_folded", "p.prefilter_skip", "p.role_family", "p.seniority_marker", "p.posted_at", "p.origin"])
      .where("p.id", "=", postingId)
      .executeTakeFirst()
    return posting === undefined || hiddenReason(visibilityFactsOf(posting), ctx) !== null
  }

  /** Nothing was sent for an approved sample: it waits for the Candidate's review again (C-SAMPLE-13). */
  async returnSampleToReview(applicationId: string, at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("application")
        .set({ sample_state: "awaiting_review", updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        .where("sample_state", "=", "approved")
        .where("submission_state", "is", null)
        .execute()
    )
  }

  /**
   * Approved samples with no submission and no job waiting in `queue` (the
   * worker stopped before claiming). Run at worker start, before jobs are
   * taken, so no job of this worker is running. The scope's Candidate's rows only.
   */
  async returnLostSamplesToReview(queue: string, at: Date): Promise<number> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("application")
        .set({ sample_state: "awaiting_review", updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("sample_state", "=", "approved")
        .where("submission_state", "is", null)
        .where(sql<boolean>`not exists (select 1 from pgboss.job j where j.name = ${queue} and j.singleton_key = application.id::text and j.state in ('created', 'retry'))`)
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows)
  }
}
