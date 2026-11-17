import { randomUUID } from "node:crypto"

import { sql } from "../db/sql.js"

import { CandidateScope } from "../db/candidate-scope.js"
import type { QueuedPostingDroppedDetail, SamplePostingDroppedDetail } from "@eve/contracts"

import type { BlockedReason, BlockedSubReason, EvidenceKind } from "../db/schema.js"
import type { CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { normaliseApplicationUrl } from "../discovery/application-url.js"
import { postingState } from "../documents/override-reader.js"
import { sharePreferences } from "../preferences/preferences-lock.js"
import type { SubmissionQueueRepository } from "./submission-queue.repository.js"

export const DAILY_CAP = 5

/** States in which an Application is "active" for the same-company rule (AC 6.6). */
export const ACTIVE_STATES = ["queued", "submit_claimed", "submitting", "confirmed", "uncertain", "blocked"] as const

export type ClaimRefusal = "paused" | "gate_not_passed" | "automatic_disabled" | "cap_reached" | "duplicate" | "same_company" | "not_claimable" | "posting_closed"

/**
 * SEC-014: bounds an automatic claim's lock waits (the Job criteria share lock
 * behind a save, the Application row, the company and day locks): 5 s lock,
 * 10 s statement, the create's pair. The lock bound is shorter than the
 * statement bound, so a wait behind a save ends with 55P03, not 57014 (QA-G5-2).
 */
export const CLAIM_TIMEOUTS = transactionTimeouts(5_000, 10_000)

/** First key of the two-key advisory lock that serialises one company's claims (SEC-503). */
export const COMPANY_LOCK_NAMESPACE = 72_006

/** Second key: a stable 32-bit hash of the trimmed, lower-cased company name (the same comparison the check uses). */
export function companyLockKey(company: string): number {
  let hash = 0
  for (const char of company.trim().toLowerCase()) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return hash
}

export type Db = CandidateTx

/** The Candidate whose `CandidateTx` a method runs in (`forCandidate` sets the scope with the setting). */
export const cid = (): string => CandidateScope.require()

/**
 * Sets CLAIM_TIMEOUTS, then takes the scope's Candidate's Job Preferences
 * row and then Job criteria row FOR SHARE (EPIC-0002 B1): the lock order of architecture.r1 and r6 (criteria first, before any
 * posting or Application row), as the save, the evaluator and the create
 * (SEC-003) take it. A save that is re-deciding postings finishes first, so
 * the posting read after this shows the committed decision; a save that
 * starts later waits for this commit.
 */
export async function shareCriteria(trx: Db): Promise<void> {
  await applyTransactionTimeouts(trx, CLAIM_TIMEOUTS)
  // EPIC-0002 B1 lock order: the Job Preferences row FOR SHARE first, then job_criteria FOR SHARE.
  await sharePreferences(trx, cid())
  await trx.selectFrom("job_criteria").select("version").where("candidate_id", "=", cid()).forShare().executeTakeFirstOrThrow()
}

/** One `submission_event` row, in `db` when the caller holds a transaction. Shared with `SubmissionQueueRepository`. */
export async function writeEvent(tenant: TenantDatabase, applicationId: string | null, kind: string, detail: string | null, at: Date, db?: Db): Promise<void> {
  const write = (tx: Db, candidateId: string) => tx.insertInto("submission_event").values({ id: randomUUID(), candidate_id: candidateId, application_id: applicationId, kind, detail, created_at: at }).execute()
  await (db ? write(db, cid()) : tenant.run(write))
}

/** Locks the Application row against deletion (which takes it FOR UPDATE) and says whether its details are still there. Shared with `SubmissionRepository`. */
export async function isLive(db: Db, applicationId: string): Promise<boolean> {
  const row = await db.selectFrom("application").select("details_deleted_at").where("candidate_id", "=", cid()).where("id", "=", applicationId).forShare().executeTakeFirst()
  return row !== undefined && row.details_deleted_at === null
}

/**
 * The claim, the point of no return, the outcome writes and the daily counts,
 * split out of `SubmissionRepository` (which delegates to this class, one
 * instance per facade).
 *
 * EPIC-0002 A1: the scope's Candidate's Applications, submission days, events
 * and outbox rows. Every statement runs in a `CandidateTx` and names its
 * `candidate_id`; methods that take a `db` run inside the caller's `run`
 * transaction. Submission is Operator only until slice E.
 */
export class SubmissionAttemptsRepository {
  constructor(private readonly tenant: TenantDatabase, private readonly queue: SubmissionQueueRepository) {}

  async logEvent(applicationId: string | null, kind: string, detail: string | null, at: Date, db?: Db): Promise<void> {
    await writeEvent(this.tenant, applicationId, kind, detail, at, db)
  }

  /**
   * The claim (architecture r1 journey 2 step 5), in one transaction: lock the
   * Application row and today's `submission_day` row, re-check pause, gate,
   * duplicates, same company and the cap, then set `submit_claimed` with a new
   * attempt ID. Automatic claims count against the cap; samples do not.
   */
  async claim(applicationId: string, kind: "automatic" | "sample", day: string, at: Date): Promise<{ attemptId: string } | { refused: ClaimRefusal }> {
    return this.tenant.run(async (trx, candidateId) => {
      // SEC-014: automatic only. Samples keep their behaviour (O6): no criteria lock, no status re-check.
      if (kind === "automatic") await shareCriteria(trx)
      const app = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", applicationId).forUpdate().executeTakeFirst()
      if (!app) return { refused: "not_claimable" as const }
      // v1.27.0 (PD-4.1, PD-4.2): a manual-only Application is never claimed; nothing counts toward the cap or the gate.
      if (await this.queue.manualOnly(trx, app)) return { refused: "not_claimable" as const }
      const claimable = kind === "sample" ? app.sample_state === "approved" && app.submission_state === null : app.submission_state === "queued"
      // AC 10.3: an Application whose detailed records were deleted is a minimal record; it is never submitted.
      if (!claimable || app.state !== "documents_ready" || app.details_deleted_at !== null) return { refused: "not_claimable" as const }
      if (kind === "automatic" && (await this.queue.dropUnlessSubmittable(trx, applicationId, at))) return { refused: "posting_closed" as const }
      const control = await trx.selectFrom("control_state").select(["global_paused", "cost_paused"]).forShare().executeTakeFirstOrThrow()
      if (control.global_paused || control.cost_paused) return { refused: "paused" as const }
      if (kind === "automatic") {
        const activation = await trx.selectFrom("activation_state").selectAll().where("candidate_id", "=", candidateId).forShare().executeTakeFirstOrThrow()
        if (activation.gate_passed_at === null) return { refused: "gate_not_passed" as const }
        if (!activation.automatic_enabled) return { refused: "automatic_disabled" as const }
      }
      if (await this.isExistingApplication(trx, app.application_url, app.requisition_id)) return { refused: "duplicate" as const }
      // SEC-503: claims at one company run one at a time, so two can't both see "no other active Application".
      if (app.company !== null && app.company.trim() !== "") await sql`select pg_advisory_xact_lock(${COMPANY_LOCK_NAMESPACE}, ${companyLockKey(app.company)})`.execute(trx)
      // CR5-04: the Candidate approved this Application's same-company hold; every other rule still applies.
      if (app.same_company_approved_at === null && (await this.hasOtherActiveAtCompany(trx, app.id, app.company))) return { refused: "same_company" as const }
      if (kind === "automatic") {
        await trx.insertInto("submission_day").values({ candidate_id: candidateId, day }).onConflict((oc) => oc.columns(["candidate_id", "day"]).doNothing()).execute()
        await sql`select day from submission_day where candidate_id = ${candidateId}::uuid and day = ${day}::date for update`.execute(trx)
        if ((await this.automaticCount(trx, day)) >= DAILY_CAP) return { refused: "cap_reached" as const }
      }
      const attemptId = randomUUID()
      await trx
        .updateTable("application")
        .set({
          submission_state: "submit_claimed",
          submission_kind: kind,
          attempt_id: attemptId,
          attempt_number: app.attempt_number + 1,
          submitted_local_day: day,
          queued_for_local_day: null,
          updated_at: at,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        .execute()
      return { attemptId }
    })
  }

  /**
   * Automatic submissions counted against `day` (AC 6.1, 9.5): claimed or
   * submitting attempts (slot reserved) and Confirmed Submissions. Unresolved
   * Uncertain Submissions, blocked, manual and sample Applications don't count.
   */
  async automaticCount(db: Db, day: string): Promise<number> {
    const row = await db
      .selectFrom("application")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("candidate_id", "=", cid())
      .where("submission_kind", "=", "automatic")
      .where(sql<boolean>`submitted_local_day = ${day}::date`)
      .where("submission_state", "in", ["submit_claimed", "submitting", "confirmed"])
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  countForDay(day: string): Promise<number> {
    return this.tenant.run((tx) => this.automaticCount(tx, day))
  }

  /** CR5-05: stored URLs are normalised on write (and by migration 0008), so the lookup normalises its side the same way. */
  async isExistingApplication(db: Db, applicationUrl: string, requisitionId: string): Promise<boolean> {
    const row = await db
      .selectFrom("existing_application")
      .select("id")
      .where("candidate_id", "=", cid())
      .where("application_url", "=", normaliseApplicationUrl(applicationUrl))
      .where((eb) => eb.or([eb("requisition_id", "=", requisitionId), eb("requisition_id", "is", null)]))
      .executeTakeFirst()
    return row !== undefined
  }

  async hasOtherActiveAtCompany(db: Db, applicationId: string, company: string | null): Promise<boolean> {
    if (company === null || company.trim() === "") return false
    const row = await db
      .selectFrom("application")
      .select("id")
      .where("candidate_id", "=", cid())
      .where("id", "!=", applicationId)
      .where(sql<boolean>`lower(company) = lower(${company})`)
      .where((eb) => eb.or([eb("submission_state", "in", [...ACTIVE_STATES]), eb("sample_state", "=", "approved").and("submission_state", "is", null)]))
      .executeTakeFirst()
    return row !== undefined
  }

  /**
   * The point of no return (journey 2 step 9): committed before the backend's
   * single submit click. "submitting" means click; anything else means don't.
   *
   * SEC-017 (AC 5.8, automatic only): in one `CandidateTx` under CLAIM_TIMEOUTS,
   * the Job criteria share lock first (architecture.r1 order, as `claim`), then
   * the Application row, then the Candidate's posting status. A save that
   * skipped the posting after the claim (during fill, the form agent, verify or
   * evidence capture) drops the attempt here, before the click: see
   * `dropClaimed`. A save that starts later waits for this commit, and by then
   * `submitting` is committed: past the point of no return. A lock wait past
   * 5 s throws 55P03 with nothing written; the caller releases the claim.
   *
   * v1.24.0 (AA-3.3) amends O6 for samples: they take the criteria share lock
   * too and require a visible ranked posting with no override (`markSampleSubmitting`).
   */
  async markSubmitting(applicationId: string, attemptId: string, kind: "automatic" | "sample", at: Date): Promise<"submitting" | "posting_closed" | "not_claimable"> {
    return this.tenant.run(async (trx, candidateId) => {
      await shareCriteria(trx)
      if (kind === "sample") return this.markSampleSubmitting(trx, candidateId, applicationId, attemptId, at)
      const app = await trx
        .selectFrom("application")
        .select(["attempt_id", "submission_state"])
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        .forUpdate()
        .executeTakeFirst()
      if (app?.attempt_id !== attemptId || app.submission_state !== "submit_claimed") return "not_claimable" as const
      const drop = await this.queue.dropOf(trx, applicationId, at)
      if (drop === null) return (await this.setSubmitting(trx, candidateId, applicationId, attemptId, at)) ? ("submitting" as const) : ("not_claimable" as const)
      await this.dropClaimed(trx, candidateId, applicationId, attemptId, drop.detail, at, drop.eligibilityChanged)
      return "posting_closed" as const
    })
  }

  /**
   * v1.24.0 sample pre-click check (AA-3.3), under the criteria share lock the
   * caller took: the posting must be visible and ranked, with no override
   * recorded. Otherwise nothing is clicked, the claim is undone and the sample
   * ends not submitted (kind sample, not counting), with a
   * `sample_posting_dropped` event (detail `hidden`, `override` or `not_ranked`).
   */
  private async markSampleSubmitting(trx: Db, candidateId: string, applicationId: string, attemptId: string, at: Date): Promise<"submitting" | "posting_closed" | "not_claimable"> {
    const app = await trx
      .selectFrom("application")
      .select(["attempt_id", "submission_state", "job_posting_id", "override_created_at", "candidate_override_at"])
      .where("candidate_id", "=", candidateId)
      .where("id", "=", applicationId)
      .forUpdate()
      .executeTakeFirst()
    if (app?.attempt_id !== attemptId || app.submission_state !== "submit_claimed") return "not_claimable" as const
    const state = await postingState(trx, candidateId, app.job_posting_id, at)
    const detail: SamplePostingDroppedDetail | null =
      state === null || state.hidden ? "hidden" : app.override_created_at !== null || app.candidate_override_at !== null ? "override" : state.decision.status !== "ranked" ? "not_ranked" : null
    if (detail === null) return (await this.setSubmitting(trx, candidateId, applicationId, attemptId, at)) ? ("submitting" as const) : ("not_claimable" as const)
    await trx
      .updateTable("application")
      .set({ submission_state: "not_submitted", submission_kind: "sample", sample_counts: false, attempt_id: null, submitted_local_day: null, attempt_number: sql`attempt_number - 1`, updated_at: at })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", applicationId)
      .where("attempt_id", "=", attemptId)
      .where("submission_state", "=", "submit_claimed")
      .execute()
    await this.logEvent(applicationId, "sample_posting_dropped", detail, at, trx)
    return "posting_closed" as const
  }

  private async setSubmitting(db: Db, candidateId: string, applicationId: string, attemptId: string, at: Date): Promise<boolean> {
    const result = await db
      .updateTable("application")
      .set({ submission_state: "submitting", submit_clicked_at: at, updated_at: at })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", applicationId)
      .where("attempt_id", "=", attemptId)
      .where("submission_state", "=", "submit_claimed")
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  /**
   * SEC-017: drops a claimed automatic attempt whose posting is no longer
   * submittable, before the click, as `dropQueued` drops a queued one: back to
   * documents ready (v1.24.0, AA-2.5, D8), logged as `queued_posting_dropped`
   * with its detail (the daily summary's Dropped list). The claim is undone as `releaseClaim` undoes it (attempt ID, day
   * and attempt number), so the cap slot is free: `automaticCount` counts
   * claimed rows by `submitted_local_day`, and `submission_day` holds no count,
   * only the lock row. Pre-click evidence events stay as the audit record.
   */
  private async dropClaimed(trx: Db, candidateId: string, applicationId: string, attemptId: string, detail: QueuedPostingDroppedDetail, at: Date, eligibilityChanged = false): Promise<void> {
    await trx
      .updateTable("application")
      .set({ submission_state: null, submission_kind: null, attempt_id: null, submitted_local_day: null, queued_for_local_day: null, attempt_number: sql`attempt_number - 1`, updated_at: at })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", applicationId)
      .where("attempt_id", "=", attemptId)
      .where("submission_state", "=", "submit_claimed")
      .execute()
    await this.logEvent(applicationId, await this.queue.dropKind(trx, applicationId, detail, eligibilityChanged), detail, at, trx)
  }

  /** Releases a claim before the click (pause): nothing was submitted, so the Application returns to where it was. */
  async releaseClaim(applicationId: string, attemptId: string, kind: "automatic" | "sample", at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("application")
        .set({ submission_state: kind === "automatic" ? "queued" : null, attempt_id: null, submitted_local_day: null, attempt_number: sql`attempt_number - 1`, updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        .where("attempt_id", "=", attemptId)
        .where("submission_state", "=", "submit_claimed")
        .execute()
    )
  }

  /**
   * `attemptId` null is a block before the claim. v1.24.0 (TM-F-02, AA-5.3): for
   * an automatic attempt (`kind`) it applies only while the Application is still
   * queued, so a Remove from queue (or a drop) during the page read is never undone.
   */
  async block(
    applicationId: string,
    attemptId: string | null,
    block: Readonly<{ reason: BlockedReason; subReason?: BlockedSubReason | null; detail: string | null; question?: string | null }>,
    at: Date,
    kind: "automatic" | "sample" | null = null
  ): Promise<void> {
    await this.tenant.run(async (trx, candidateId) => {
      let query = trx
        .updateTable("application")
        .set({
          submission_state: "blocked",
          blocked_reason: block.reason,
          blocked_sub_reason: block.subReason ?? null,
          blocked_detail: block.detail,
          // FE5-B5: the Missing Approved Answer question as the form asked it.
          blocked_question: block.reason === "missing_approved_answer" ? (block.question ?? null) : null,
          blocked_at: at,
          submitted_local_day: null,
          updated_at: at,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        // SEC-701: a pre-claim block that lands after the details were deleted writes no employer text back.
        .where("details_deleted_at", "is", null)
        .where((eb) => eb.or([eb("submission_state", "is", null), eb("submission_state", "not in", ["submitting", "confirmed", "uncertain", "manual", "declined"])]))
      if (attemptId !== null) query = query.where("attempt_id", "=", attemptId)
      else if (kind === "automatic") query = query.where("submission_state", "=", "queued")
      else if (kind === "sample") query = query.where("submission_state", "is", null)
      const result = await query.executeTakeFirst()
      if (Number(result.numUpdatedRows) === 1) await this.outbox(trx, applicationId, "blocked", at)
    })
  }

  /** Journey 2 step 10: Confirmed or Uncertain, with the outbox row in the same transaction. Never retried. */
  async finish(
    applicationId: string,
    attemptId: string,
    result: Readonly<{ evidence: { kind: EvidenceKind; text: string } | null; captchaAfterSubmit: boolean; coverLetterUploaded: boolean | null }>,
    at: Date
  ): Promise<void> {
    await this.tenant.run(async (trx, candidateId) => {
      const app = await trx.selectFrom("application").select(["submission_kind"]).where("candidate_id", "=", candidateId).where("id", "=", applicationId).forUpdate().executeTakeFirstOrThrow()
      const updated = await trx
        .updateTable("application")
        .set({
          submission_state: result.evidence ? "confirmed" : "uncertain",
          confirmed_at: result.evidence ? at : null,
          evidence_kind: result.evidence?.kind ?? null,
          evidence_text: result.evidence?.text ?? null,
          captcha_after_submit: result.captchaAfterSubmit,
          cover_letter_status: result.coverLetterUploaded === null ? undefined : result.coverLetterUploaded ? "uploaded" : "no_field",
          sample_counts: app.submission_kind === "sample" ? true : undefined,
          updated_at: at,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        .where("attempt_id", "=", attemptId)
        .where("submission_state", "=", "submitting")
        .executeTakeFirst()
      if (Number(updated.numUpdatedRows) !== 1) return
      await this.outbox(trx, applicationId, result.evidence ? "confirmed" : "uncertain", at)
      if (app.submission_kind === "sample") await this.passGateIfReady(trx, at)
    })
  }

  /** AC 2.4: the gate passes once, when the Career Profile is approved, existing applications are complete and five samples count. */
  async passGateIfReady(db: Db, at: Date): Promise<void> {
    const candidateId = cid()
    const activation = await db.selectFrom("activation_state").selectAll().where("candidate_id", "=", candidateId).forUpdate().executeTakeFirstOrThrow()
    if (activation.gate_passed_at !== null || activation.existing_applications_completed_at === null) return
    const profile = await db.selectFrom("career_profile_version").select("version").where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst()
    if (!profile) return
    if ((await this.countingSamples(db)) < 5) return
    await db.updateTable("activation_state").set({ gate_passed_at: at }).where("candidate_id", "=", candidateId).execute()
  }

  async countingSamples(db?: Db): Promise<number> {
    const read = async (tx: Db, candidateId: string) => {
      const row = await tx.selectFrom("application").select((eb) => eb.fn.countAll<string>().as("count")).where("candidate_id", "=", candidateId).where("sample_counts", "=", true).executeTakeFirstOrThrow()
      return Number(row.count)
    }
    return db ? read(db, cid()) : this.tenant.run(read)
  }

  /** ADR 0005: after a crash, the scope's Candidate's claims or clicks in flight become Uncertain and are never re-queued. */
  async recoverInterrupted(at: Date): Promise<number> {
    return this.tenant.run(async (trx, candidateId) => {
      const rows = await trx
        .updateTable("application")
        .set({ submission_state: "uncertain", updated_at: at })
        .where("candidate_id", "=", candidateId)
        .where("submission_state", "in", ["submit_claimed", "submitting"])
        .returning(["id", "submission_kind"])
        .execute()
      let sampleRecovered = false
      for (const row of rows) {
        await this.outbox(trx, row.id, "uncertain", at)
        if (row.submission_kind !== "sample") continue
        await trx.updateTable("application").set({ sample_counts: true }).where("candidate_id", "=", candidateId).where("id", "=", row.id).execute()
        sampleRecovered = true
      }
      // CR5-06: a recovered sample counts, so the gate is re-evaluated as `finish` does.
      if (sampleRecovered) await this.passGateIfReady(trx, at)
      return rows.length
    })
  }

  async outbox(db: Db, applicationId: string, kind: "confirmed" | "blocked" | "uncertain", at: Date): Promise<void> {
    // SEC-701: no notification row for an Application whose details were deleted.
    if (!(await isLive(db, applicationId))) return
    // Slice 6: one success email per Application (unique index), so a second confirmation adds no row.
    await db
      .insertInto("notification_outbox")
      .values({ id: randomUUID(), candidate_id: cid(), application_id: applicationId, kind, created_at: at, sent_at: null, status: kind === "uncertain" ? "skipped" : "pending" })
      .onConflict((oc) => oc.column("application_id").where("kind", "=", "confirmed").doNothing())
      .execute()
  }
}
