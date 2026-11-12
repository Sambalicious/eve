import { Injectable } from "@nestjs/common"
import type { SampleStateValue } from "@eve/contracts"
import { sql } from "../db/sql.js"

import { CandidateScope } from "../db/candidate-scope.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { tierMapIn } from "../discovery/tier-map.js"
import { sharePreferences } from "../preferences/preferences-lock.js"
import { type VisibilityContext, visibilityContext, visibleSql } from "../discovery/visibility.js"

type Db = CandidateTx

const cid = (): string => CandidateScope.require()

/**
 * Bounds a preparation's lock waits (the activation row, then the Job criteria
 * share lock behind a save): 5 s lock, 10 s statement, the create's pair. In the
 * api the pool's 5 s statement_timeout would otherwise end the criteria wait
 * with 57014 instead of 55P03 (QA-G5-2, g6 r1).
 */
export const PREPARE_TIMEOUTS = transactionTimeouts(5_000, 10_000)

/**
 * Queries for Activation Gate samples and the dashboard counts (FE5-B1). Each list is one query.
 * EPIC-0002 A1: the scope's Candidate's rows only; Candidate tables joined on
 * `candidate_id` too. `job_posting` is shared facts; status and discovery
 * time come from the Candidate's `candidate_posting` row (item 6).
 */
@Injectable()
export class SampleRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** A preparation transaction in the scope's Candidate's CandidateTx, with PREPARE_TIMEOUTS set before any locking statement. */
  transaction<T>(work: (trx: CandidateTx) => Promise<T>): Promise<T> {
    return this.tenant.run(async (trx) => {
      await applyTransactionTimeouts(trx, PREPARE_TIMEOUTS)
      return work(trx)
    })
  }

  /** Serialises the Candidate's preparations: their activation row is the lock (released at commit). */
  lockActivation(trx: CandidateTx) {
    return trx.selectFrom("activation_state").selectAll().where("candidate_id", "=", cid()).forUpdate().executeTakeFirstOrThrow()
  }

  /**
   * The scope's Candidate's Job criteria row FOR SHARE (SEC-002), taken after the activation lock.
   * A save holds it FOR UPDATE while it re-decides postings, so candidates read
   * after this see only committed statuses, and a later save waits for commit.
   */
  async shareCriteria(trx: CandidateTx): Promise<void> {
    // EPIC-0002 B1 lock order (r6 SampleRepository.sharePreferences): the Job Preferences row FOR SHARE, then job_criteria FOR SHARE.
    await sharePreferences(trx, cid())
    await trx.selectFrom("job_criteria").select("version").where("candidate_id", "=", cid()).forShare().executeTakeFirstOrThrow()
  }

  /** EPIC-0006: the scope Candidate's visibility context from the criteria row this transaction holds FOR SHARE. */
  visibilityContext(trx: CandidateTx, now: Date): Promise<VisibilityContext> {
    return visibilityContext(trx, cid(), now, "share")
  }

  readControl(db: Db) {
    return db.selectFrom("control_state").select(["global_paused", "cost_paused"]).executeTakeFirstOrThrow()
  }

  async hasApprovedProfile(db: Db): Promise<boolean> {
    return (await db.selectFrom("career_profile_version").select("version").where("candidate_id", "=", cid()).where("status", "=", "approved").executeTakeFirst()) !== undefined
  }

  /** Samples that count, plus those awaiting review or approved and still in flight (they may count). */
  async openSamples(db: Db): Promise<number> {
    const row = await db
      .selectFrom("application")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("candidate_id", "=", cid())
      .where((eb) =>
        eb.or([
          eb("sample_counts", "=", true),
          eb("sample_state", "=", "awaiting_review"),
          eb.and([eb("sample_state", "=", "approved"), eb("submission_state", "in", ["submit_claimed", "submitting"])]),
          eb.and([eb("sample_state", "=", "approved"), eb("submission_state", "is", null)]),
        ])
      )
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  /**
   * Sample candidates (AC 2.1, design F2): documents ready, not yet in
   * submission or sampling, an automatic posting that is ranked, eligible and a
   * strong Match, not a recorded existing application, and no other active or
   * sampled Application at the same company. EPIC-0006 (AC-3.9): and visible
   * for the scope Candidate under `ctx` (read from the criteria row this
   * transaction holds FOR SHARE).
   */
  /** EPIC-0002 B1: the Candidate's tier map, so samples follow the Ranked tab order. */
  tierMap(db: Db) {
    return tierMapIn(db, cid())
  }

  candidates(db: Db, ctx: VisibilityContext) {
    const candidateId = cid()
    return db
      .selectFrom("application")
      .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
      .innerJoin("candidate_posting", (join) => join.onRef("candidate_posting.job_posting_id", "=", "job_posting.id").on("candidate_posting.candidate_id", "=", candidateId))
      .innerJoin("eligibility_result", (join) => join.onRef("eligibility_result.job_posting_id", "=", "job_posting.id").on("eligibility_result.candidate_id", "=", candidateId))
      .innerJoin("match_evidence", (join) => join.onRef("match_evidence.job_posting_id", "=", "job_posting.id").on("match_evidence.candidate_id", "=", candidateId))
      .select([
        "application.id",
        "application.company",
        "job_posting.id as job_posting_id",
        "job_posting.role_family",
        "candidate_posting.discovered_at",
        "candidate_posting.origin",
        "match_evidence.covered_count",
        "match_evidence.total_count",
        "match_evidence.ats_fit",
      ])
      .where("application.candidate_id", "=", candidateId)
      .where("application.state", "=", "documents_ready")
      .where("application.submission_state", "is", null)
      .where("application.sample_state", "is", null)
      // v1.24.0 (AA-3.4, D4): an Application with an override recorded is never a sample.
      .where("application.override_created_at", "is", null)
      .where("application.candidate_override_at", "is", null)
      .where("candidate_posting.status", "=", "ranked")
      .where(visibleSql("job_posting", ctx))
      .where("job_posting.apply_mode", "=", "automatic")
      .where("eligibility_result.eligible", "=", true)
      .where("match_evidence.verdict", "=", "strong")
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("existing_application as e")
              .select("e.id")
              .where("e.candidate_id", "=", candidateId)
              .whereRef("e.application_url", "=", "application.application_url")
              .where(sql<boolean>`(e.requisition_id = application.requisition_id or e.requisition_id is null)`)
          )
        )
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("application as other")
              .select("other.id")
              .where("other.candidate_id", "=", candidateId)
              .whereRef("other.id", "!=", "application.id")
              .where(sql<boolean>`lower(other.company) = lower(application.company)`)
              .where((eb) =>
                eb.or([
                  eb("other.submission_state", "in", ["queued", "submit_claimed", "submitting", "confirmed", "uncertain", "blocked"]),
                  eb("other.sample_state", "in", ["awaiting_review", "approved"]),
                ])
              )
          )
        )
      )
      .limit(500)
      .execute()
  }

  async markAwaiting(trx: CandidateTx, ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return
    await trx
      .updateTable("application")
      .set({ sample_state: "awaiting_review", updated_at: at })
      .where("candidate_id", "=", cid())
      .where("id", "in", ids)
      .where("sample_state", "is", null)
      .where("submission_state", "is", null)
      .execute()
  }

  /** Samples in one state with what each row shows (newest change first, at most 500). */
  listByState(state: SampleStateValue) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
        .leftJoin("match_evidence", (join) => join.onRef("match_evidence.job_posting_id", "=", "job_posting.id").on("match_evidence.candidate_id", "=", candidateId))
        .leftJoin("eligibility_result", (join) => join.onRef("eligibility_result.job_posting_id", "=", "job_posting.id").on("eligibility_result.candidate_id", "=", candidateId))
        .selectAll("application")
        .select((eb) => [
          eb.cast<string | null>("application.submitted_local_day", "text").as("submitted_local_day"),
          eb.cast<string | null>("application.queued_for_local_day", "text").as("queued_for_local_day"),
          "job_posting.application_system",
          "match_evidence.covered_count",
          "match_evidence.total_count",
          "eligibility_result.rules",
        ])
        .where("application.candidate_id", "=", candidateId)
        .where("application.sample_state", "=", state)
        .orderBy("application.updated_at", "desc")
        .orderBy("application.id")
        .limit(500)
        .execute()
    )
  }

  /** Home's Needs you list and the sidebar badges, in one query. */
  summary() {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .select((eb) => [
          eb.fn.countAll<string>().filterWhere("sample_state", "=", "awaiting_review").as("awaiting"),
          eb.fn.countAll<string>().filterWhere("sample_state", "=", "approved").as("approved"),
          eb.fn.countAll<string>().filterWhere("sample_state", "=", "rejected").as("rejected"),
          eb.fn.countAll<string>().filterWhere((w) => w.and([w("submission_state", "=", "blocked"), w("blocked_reason", "!=", "same_company_review")])).as("blocked"),
          eb.fn.countAll<string>().filterWhere((w) => w.and([w("submission_state", "=", "blocked"), w("blocked_reason", "=", "same_company_review")])).as("held"),
          eb.fn.countAll<string>().filterWhere("submission_state", "=", "uncertain").as("uncertain"),
        ])
        .where("candidate_id", "=", candidateId)
        .executeTakeFirstOrThrow()
    )
  }

  findFormRead(applicationId: string) {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("application_form_read").selectAll().where("candidate_id", "=", candidateId).where("application_id", "=", applicationId).executeTakeFirst()
    )
  }

  /** Samples awaiting review whose form has not been read yet (the worker reads them so the review can list every answer). */
  async awaitingWithoutFormRead(): Promise<string[]> {
    const rows = await this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .leftJoin("application_form_read", "application_form_read.application_id", "application.id")
        .select("application.id")
        .where("application.candidate_id", "=", candidateId)
        .where("application.sample_state", "=", "awaiting_review")
        .where("application_form_read.application_id", "is", null)
        .orderBy("application.id")
        .limit(5)
        .execute()
    )
    return rows.map((row) => row.id)
  }

  applicationExists(applicationId: string) {
    return this.tenant.run((tx, candidateId) => tx.selectFrom("application").select("id").where("candidate_id", "=", candidateId).where("id", "=", applicationId).executeTakeFirst())
  }
}
