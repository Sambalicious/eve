import { randomUUID } from "node:crypto"

import { Inject, Injectable } from "@nestjs/common"
import {
  type ApplicationOverride,
  DAILY_AUTOMATIC_CAP,
  type CreateExistingApplicationRequest,
  type ExistingApplication,
  type ExistingApplicationsResponse,
  REASON_MAX,
  REQUIRED_SAMPLES,
  type SampleResult,
  type Submission,
  type SubmissionListResponse,
  type SubmissionListView,
  type SubmissionStatus,
} from "@eve/contracts"
import { type Selectable } from "kysely"
import { sql } from "../db/sql.js"

import type { ApplicationTable, ExistingApplicationTable } from "../db/schema.js"
import { normaliseApplicationUrl } from "../discovery/application-url.js"
import { summaryOf } from "../documents/documents.service.js"
import { overridesFor } from "../documents/override-reader.js"
import { readGraceEnd } from "../records/retention-view.js"
import { sharePreferences } from "../preferences/preferences-lock.js"
import { CandidateIdentityRepository } from "../auth/candidate-identity.repository.js"
import { ApiException } from "../http/api-exception.js"
import { lockActivation, upsertAdvanced } from "../me/view-setting.js"
import { capabilityFor } from "../shared/converted-features.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { SubmissionRepository } from "./submission.repository.js"
import { SampleSubmissionQueue } from "./sample-submission-queue.js"
import { nextWatDay, watDay } from "./wat-day.js"

/**
 * Candidate actions on submission (AC 2, 6.6, 9.3 to 9.5, 1.6). Each action
 * locks the Application row, so double clicks and two tabs apply one decision.
 */
@Injectable()
export class SubmissionStateService {
  constructor(
    private readonly repository: SubmissionRepository,
    private readonly sampleQueue: SampleSubmissionQueue,
    private readonly identities: CandidateIdentityRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async status(): Promise<SubmissionStatus> {
    const now = this.clock.now()
    const today = watDay(now)
    const [activation, control, counting, todayCount] = await Promise.all([
      this.repository.readActivation(),
      this.repository.readControl(),
      this.repository.countingSamples(),
      this.repository.countForDay(today),
    ])
    const { profile, queued } = await this.repository.run(async (tx, candidateId) => ({
      profile: await tx.selectFrom("career_profile_version").select("version").where("candidate_id", "=", candidateId).where("status", "=", "approved").executeTakeFirst(),
      queued: await tx
        .selectFrom("application")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("candidate_id", "=", candidateId)
        .where("submission_state", "=", "queued")
        .where(sql<boolean>`queued_for_local_day = ${nextWatDay(today)}::date`)
        .executeTakeFirstOrThrow(),
    }))
    return {
      automaticEnabled: activation.automatic_enabled,
      gatePassedAt: activation.gate_passed_at?.toISOString() ?? null,
      careerProfileApproved: profile !== undefined,
      existingApplicationsCompletedAt: activation.existing_applications_completed_at?.toISOString() ?? null,
      countingSamples: counting,
      requiredSamples: REQUIRED_SAMPLES,
      todayWatDay: today,
      todayCount,
      cap: DAILY_AUTOMATIC_CAP,
      queuedForTomorrow: Number(queued.count),
      globalPaused: control.global_paused,
    }
  }

  /**
   * AC 1.6, 2.3: enabling needs the passed gate. Disabling is always allowed.
   * EPIC-0011 D4: enabling also turns Advanced on in the same transaction (lock
   * order `activation_state` then `candidate_view_setting`); disabling leaves
   * the flag as it is.
   */
  async setAutomatic(enabled: boolean): Promise<SubmissionStatus> {
    await this.repository.run(async (tx, candidateId) => {
      await lockActivation(tx, candidateId)
      if (enabled) {
        const activation = await tx.selectFrom("activation_state").select("gate_passed_at").where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()
        if (activation.gate_passed_at === null) throw new ApiException("gate_requirements_unmet")
      }
      await tx.updateTable("activation_state").set({ automatic_enabled: enabled }).where("candidate_id", "=", candidateId).execute()
      if (enabled) await upsertAdvanced(tx, candidateId, true, this.clock.now())
    })
    return this.status()
  }

  /** One query for the Blocked, Uncertain and same-company review lists (newest block or submit time first, at most 500). */
  async list(view: SubmissionListView): Promise<SubmissionListResponse> {
    const now = this.clock.now()
    const { rows, graceEnd, overrides } = await this.repository.run(async (tx, candidateId) => {
      const rows = await tx
        .selectFrom("application")
        .selectAll()
        .where("candidate_id", "=", candidateId)
        // Date columns as YYYY-MM-DD text, as findApplication reads them (pg would give a local-midnight Date).
        .select((eb) => [eb.cast<string | null>("submitted_local_day", "text").as("submitted_local_day"), eb.cast<string | null>("queued_for_local_day", "text").as("queued_for_local_day")])
        .where((eb) => {
          const blocked = eb.and([eb("submission_state", "=", "blocked"), eb("blocked_reason", "!=", "same_company_review")])
          const held = eb.and([eb("submission_state", "=", "blocked"), eb("blocked_reason", "=", "same_company_review")])
          const uncertain = eb("submission_state", "=", "uncertain")
          if (view === "blocked") return blocked
          if (view === "held") return held
          if (view === "uncertain") return uncertain
          return eb.or([blocked, held, uncertain])
        })
        .orderBy(sql`coalesce(blocked_at, submit_clicked_at, updated_at)`, "desc")
        .orderBy("id")
        .limit(500)
        .execute()
      return { rows, graceEnd: await readGraceEnd(tx, candidateId, now), overrides: await overridesFor(tx, candidateId, rows, now) }
    })
    return {
      rows: rows.map((row) => {
        const override = overrides.get(row.id) ?? null
        return { application: summaryOf(row, graceEnd, override), submission: submissionOf(row, override) }
      }),
    }
  }

  async submission(id: string): Promise<Submission> {
    const row = await this.repository.findApplication(id)
    if (!row) throw new ApiException("not_found")
    const now = this.clock.now()
    const overrides = await this.repository.run((tx, candidateId) => overridesFor(tx, candidateId, [row], now))
    return submissionOf(row, overrides.get(row.id) ?? null)
  }

  /** Makes a documents-ready Application an Activation Gate sample awaiting review. After the gate: `409 gate_passed`. */
  async makeSample(id: string): Promise<Submission> {
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      // Threat model CHK-33: an Application the Candidate does not hold is 404 before any hidden check (no existence oracle).
      if (!row) throw new ApiException("not_found")
      // EPIC-0006 (AC-3.9): a posting hidden for this Candidate starts no sample; nothing changes. Criteria FOR SHARE.
      if (await this.repository.postingHiddenFor(trx, candidateId, row.job_posting_id, this.clock.now())) throw new ApiException("posting_hidden")
      // v1.27.0 (PD-4.1): a manual-only Application is never a sample; nothing changes.
      if (await this.repository.manualOnly(trx, row)) throw new ApiException("manual_application_only")
      if (row.sample_state !== null) return
      // SEC-507 / F-QA5B-01: samples exist only before the gate; the gate row is locked against a concurrent pass.
      const activation = await trx.selectFrom("activation_state").select("gate_passed_at").where("candidate_id", "=", candidateId).forShare().executeTakeFirstOrThrow()
      if (activation.gate_passed_at !== null) throw new ApiException("gate_passed")
      // v1.24.0 (AA-3.1, D4): an override (applying or not, legacy included) or a posting that isn't ranked is never a sample.
      if (row.override_created_at !== null || row.candidate_override_at !== null) throw new ApiException("sample_not_allowed")
      const posting = await trx.selectFrom("candidate_posting").select("status").where("candidate_id", "=", candidateId).where("job_posting_id", "=", row.job_posting_id).executeTakeFirst()
      if (posting?.status !== "ranked") throw new ApiException("sample_not_allowed")
      if (row.state !== "documents_ready" || row.submission_state !== null) throw new ApiException("application_state_conflict")
      await trx.updateTable("application").set({ sample_state: "awaiting_review", updated_at: this.clock.now() }).where("candidate_id", "=", candidateId).where("id", "=", id).execute()
    })
    return this.submission(id)
  }

  /**
   * AC 2.2 (F-QA5-01): the api has no browser (ADR 0008), so approving records
   * the decision and hands the sample to the worker's `submission.sample` job in
   * the same transaction; the worker submits it at once, under every rule except
   * the automatic cap. The answer is `pending`; the web polls the Submission.
   * Paused at approval: nothing is recorded or queued (C-SAMPLE-13). A second
   * approval returns the first result with `alreadyDone`.
   */
  async approveSample(id: string): Promise<SampleResult> {
    const decision = await this.repository.run(async (trx, candidateId) => {
      // EPIC-0002 B1 lock order (merge with main 0422b14): the Job Preferences row FOR SHARE before any application
      // row or job_criteria lock, so a running preferences save's re-decision commits before the posting check below.
      await sharePreferences(trx, candidateId)
      const row = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      // v1.27.0 (PD-4.1): a manual-only Application is never approved or sent as a sample; nothing is written.
      if (await this.repository.manualOnly(trx, row)) throw new ApiException("manual_application_only")
      if (row.sample_state === "approved") return "already" as const
      if (row.sample_state !== "awaiting_review") throw new ApiException("not_a_sample")
      const control = await trx.selectFrom("control_state").select(["global_paused", "cost_paused"]).executeTakeFirstOrThrow()
      if (control.global_paused || control.cost_paused) return "paused" as const
      // v1.24.0 (AA-3.2): the posting check reads the current status under the Job criteria share lock.
      await trx.selectFrom("job_criteria").select("version").where("candidate_id", "=", candidateId).forShare().executeTakeFirstOrThrow()
      const posting = await trx.selectFrom("candidate_posting").select("status").where("candidate_id", "=", candidateId).where("job_posting_id", "=", row.job_posting_id).executeTakeFirstOrThrow()
      await trx.updateTable("application").set({ sample_state: "approved", updated_at: this.clock.now() }).where("candidate_id", "=", candidateId).where("id", "=", id).execute()
      const refused = approvalRefusal(posting.status, row.override_created_at !== null || row.candidate_override_at !== null)
      if (refused !== null) {
        // Nothing is queued or sent and it does not count toward the five (AA-3.2).
        await trx.updateTable("application").set({ submission_state: "not_submitted", submission_kind: "sample", sample_counts: false }).where("candidate_id", "=", candidateId).where("id", "=", id).execute()
        return refused
      }
      await this.sampleQueue.enqueue(trx, id)
      return "pending" as const
    })
    if (decision === "already") return this.sampleResult(id, true)
    if (decision === "excluded" || decision === "not_ranked" || decision === "not_allowed") return { ...(await this.sampleResult(id, false)), result: decision }
    if (decision === "paused") return { ...(await this.sampleResult(id, false)), result: "not_submitted" }
    return this.sampleResult(id, false)
  }

  async rejectSample(id: string, reason: string): Promise<Submission> {
    const text = reasonText(reason)
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").select(["sample_state"]).where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.sample_state === "rejected") return
      if (row.sample_state !== "awaiting_review") throw new ApiException("not_a_sample")
      await trx.updateTable("application").set({ sample_state: "rejected", sample_reject_reason: text, updated_at: this.clock.now() }).where("candidate_id", "=", candidateId).where("id", "=", id).execute()
    })
    return this.submission(id)
  }

  /** Puts a documents-ready Application in the automatic queue (after the gate). */
  async queue(id: string): Promise<Submission> {
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      // v1.27.0 (PD-4.1): a manual-only Application is never queued, whatever its state; nothing changes.
      if (await this.repository.manualOnly(trx, row)) throw new ApiException("manual_application_only")
      if (row.submission_state === "queued") return
      if (row.submission_state === "blocked" && row.blocked_reason === "automation_incomplete") throw new ApiException("automation_incomplete_not_requeueable")
      const fromBlocked = row.submission_state === "blocked" && row.blocked_reason !== "same_company_review"
      if (row.state !== "documents_ready" || !(row.submission_state === null || fromBlocked) || row.sample_state !== null) {
        throw new ApiException("application_state_conflict")
      }
      await trx
        .updateTable("application")
        .set({ submission_state: "queued", submission_kind: "automatic", blocked_reason: null, blocked_sub_reason: null, blocked_detail: null, blocked_question: null, blocked_at: null, updated_at: this.clock.now() })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    })
    return this.submission(id)
  }

  /**
   * v1.24.0 (AA-5): takes a queued Application out of the automatic queue. The
   * row is locked FOR UPDATE, as the claim locks it, so a removal and a claim
   * never both succeed (AA-5.3). No pause check (AA-5.4). State null is a no-op
   * (R-4409); any state past the queue, or a minimal record, is refused.
   */
  async removeFromQueue(id: string): Promise<Submission> {
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").select(["submission_state", "details_deleted_at"]).where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.details_deleted_at !== null) throw new ApiException("application_state_conflict")
      if (row.submission_state === null) return
      if (row.submission_state !== "queued") throw new ApiException("application_state_conflict")
      const now = this.clock.now()
      await trx
        .updateTable("application")
        .set({ submission_state: null, submission_kind: null, queued_for_local_day: null, updated_at: now })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
      await this.repository.logEvent(id, "queue_removed", null, now, trx)
    })
    return this.submission(id)
  }

  /** AC 9.4: the Candidate's "confirmed" mark is the evidence; it counts on its submission day. */
  async markConfirmed(id: string): Promise<Submission> {
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").select(["submission_state"]).where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.submission_state === "confirmed") return
      if (row.submission_state !== "uncertain") throw new ApiException("application_state_conflict")
      const now = this.clock.now()
      await trx
        .updateTable("application")
        .set({ submission_state: "confirmed", evidence_kind: "marked_confirmed", evidence_text: null, confirmed_at: now, updated_at: now })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
      // E1 "Confirmed by: Marked confirmed by you": the success email, written with the state change.
      await this.repository.outbox(trx, id, "confirmed", now)
    })
    return this.submission(id)
  }

  /**
   * AC 9.4: "not submitted" returns an automatic Uncertain Submission to the
   * queue for one fresh attempt; a second uncertain result is final. A sample
   * stops counting and gets no further attempt (AC 2.6). A confirmation that
   * came first wins.
   */
  async markNotSubmitted(id: string): Promise<Submission> {
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.submission_state === "confirmed" || row.submission_state === "queued" || row.submission_state === "not_submitted") return
      if (row.submission_state !== "uncertain") throw new ApiException("application_state_conflict")
      const now = this.clock.now()
      const fresh = row.submission_kind === "automatic" && row.attempt_number < 2
      await trx
        .updateTable("application")
        .set({
          submission_state: fresh ? "queued" : "not_submitted",
          sample_counts: false,
          submitted_local_day: null,
          attempt_id: null,
          captcha_after_submit: false,
          marked_not_submitted_at: now,
          updated_at: now,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    })
    return this.submission(id)
  }

  /**
   * AC 9.3 and EPIC-0011 C3. The Draft path (no submission state, no sample) is
   * open to every Candidate and never counts toward the cap. The blocked path
   * needs the `submission` capability, checked here because the route no longer
   * carries `@ConvertedFeature`. Order matters: step 5 (blocked) is decided
   * before step 6 (Draft), so a non-Operator can never complete a blocked row.
   */
  async manualComplete(id: string): Promise<Submission> {
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").select(["submission_state", "sample_state", "details_deleted_at"]).where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.submission_state === "manual") return
      if (row.submission_state === "blocked") {
        if (capabilityFor("submission", await this.identities.isOperator(candidateId)) !== "available") throw ApiException.featureNotYetAvailable("submission")
      } else if (row.submission_state === null) {
        if (row.details_deleted_at !== null || row.sample_state !== null) throw new ApiException("application_state_conflict")
      } else {
        throw new ApiException("application_state_conflict")
      }
      const now = this.clock.now()
      await trx
        .updateTable("application")
        .set({ submission_state: "manual", manual_completed_at: now, submitted_local_day: null, updated_at: now })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    })
    return this.submission(id)
  }

  /** AC 6.6: approving a same-company hold queues it under the normal rules. */
  async approveSameCompany(id: string): Promise<Submission> {
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").select(["submission_state", "blocked_reason"]).where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.submission_state === "declined") throw new ApiException("posting_declined")
      if (row.submission_state !== "blocked" || row.blocked_reason !== "same_company_review") throw new ApiException("application_state_conflict")
      await trx
        .updateTable("application")
        .set({
          submission_state: "queued",
          submission_kind: "automatic",
          blocked_reason: null,
          blocked_detail: null,
          blocked_question: null,
          blocked_at: null,
          // CR5-04: the claim reads this and skips the same-company check for this Application only.
          same_company_approved_at: this.clock.now(),
          updated_at: this.clock.now(),
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    })
    return this.submission(id)
  }

  /** AC 6.6: declining drops the posting with the reason; the first reason is kept. */
  async declineSameCompany(id: string, reason: string): Promise<Submission> {
    const text = reasonText(reason)
    await this.repository.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").select(["submission_state", "blocked_reason"]).where("candidate_id", "=", candidateId).where("id", "=", id).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.submission_state === "declined") return
      if (row.submission_state !== "blocked" || row.blocked_reason !== "same_company_review") throw new ApiException("application_state_conflict")
      await trx
        .updateTable("application")
        .set({ submission_state: "declined", declined_reason: text, declined_at: this.clock.now(), blocked_reason: null, blocked_detail: null, blocked_question: null, updated_at: this.clock.now() })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    })
    return this.submission(id)
  }

  async existingApplications(): Promise<ExistingApplicationsResponse> {
    const [rows, activation] = await Promise.all([
      this.repository.run((tx, candidateId) =>
        tx
          .selectFrom("existing_application")
          .selectAll()
          .select((eb) => eb.cast<string>("applied_on", "text").as("applied_on"))
          .where("candidate_id", "=", candidateId)
          .orderBy("created_at")
          .limit(1000)
          .execute()
      ),
      this.repository.readActivation(),
    ])
    return { applications: rows.map(existingOf), completedAt: activation.existing_applications_completed_at?.toISOString() ?? null }
  }

  async addExistingApplication(request: CreateExistingApplicationRequest): Promise<{ created: boolean; application: ExistingApplication }> {
    const company = request.company.trim()
    const roleTitle = request.roleTitle.trim()
    const typedUrl = request.applicationUrl.trim()
    const appliedOn = request.appliedOn.trim()
    if (company === "") throw new ApiException("existing_application_company_empty")
    if (roleTitle === "") throw new ApiException("existing_application_role_empty")
    if (typedUrl === "") throw new ApiException("existing_application_url_empty")
    if (appliedOn === "") throw new ApiException("existing_application_date_empty")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedOn) || Number.isNaN(Date.parse(appliedOn)) || !/^https?:\/\//i.test(typedUrl)) throw new ApiException("bad_request")
    // CR5-05: the same normalisation postings use, so a copied link with a trailing slash or tracking parameter still matches.
    const applicationUrl = normaliseApplicationUrl(typedUrl)
    const requisitionId = request.requisitionId?.trim() || null
    const { inserted, row } = await this.repository.run(async (tx, candidateId) => {
      const inserted = await tx
        .insertInto("existing_application")
        .values({ id: randomUUID(), candidate_id: candidateId, company, role_title: roleTitle, application_url: applicationUrl, requisition_id: requisitionId, applied_on: appliedOn, created_at: this.clock.now() })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst()
      const row = await tx
        .selectFrom("existing_application")
        .selectAll()
        .select((eb) => eb.cast<string>("applied_on", "text").as("applied_on"))
        .where("candidate_id", "=", candidateId)
        .where("application_url", "=", applicationUrl)
        .where(sql<boolean>`coalesce(requisition_id, '') = ${requisitionId ?? ""}`)
        .executeTakeFirstOrThrow()
      return { inserted, row }
    })
    return { created: inserted !== undefined, application: existingOf(row) }
  }

  async completeExistingApplications(): Promise<ExistingApplicationsResponse> {
    const now = this.clock.now()
    await this.repository.run(async (trx, candidateId) => {
      await trx.updateTable("activation_state").set({ existing_applications_completed_at: now }).where("candidate_id", "=", candidateId).where("existing_applications_completed_at", "is", null).execute()
      await this.repository.passGateIfReady(trx, now)
    })
    return this.existingApplications()
  }

  /** The worker refused the sample's claim as a duplicate requisition (C-SAMPLE-4). */
  private async refusedAsDuplicate(id: string): Promise<boolean> {
    const event = await this.repository.run((tx, candidateId) =>
      tx.selectFrom("submission_event").select("id").where("candidate_id", "=", candidateId).where("application_id", "=", id).where("kind", "=", "claim_refused_duplicate").executeTakeFirst()
    )
    return event !== undefined
  }

  /**
   * A not-submitted sample's result: `duplicate` when the worker refused it as a duplicate (C-SAMPLE-4); for a
   * repeat approval (v1.24.0, AA-3.2), the refusal recorded at approval or at the pre-click check (`excluded`,
   * `not_ranked`, `not_allowed`), read from the posting and the override as they are now.
   */
  private async notSubmittedResult(id: string, alreadyDone: boolean): Promise<SampleResult["result"]> {
    if (await this.refusedAsDuplicate(id)) return "duplicate"
    if (!alreadyDone) return "not_submitted"
    const facts = await this.repository.run(async (tx, candidateId) => {
      const app = await tx.selectFrom("application").select(["job_posting_id", "override_created_at", "candidate_override_at"]).where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirstOrThrow()
      const posting = await tx.selectFrom("candidate_posting").select("status").where("candidate_id", "=", candidateId).where("job_posting_id", "=", app.job_posting_id).executeTakeFirst()
      const dropped = await tx.selectFrom("submission_event").select("detail").where("candidate_id", "=", candidateId).where("application_id", "=", id).where("kind", "=", "sample_posting_dropped").executeTakeFirst()
      return { status: posting?.status ?? null, override: app.override_created_at !== null || app.candidate_override_at !== null, dropped: dropped?.detail ?? null }
    })
    if (facts.dropped === "override") return "not_allowed"
    if (facts.dropped !== null) return "not_ranked"
    return (facts.status === null ? null : approvalRefusal(facts.status, facts.override)) ?? "not_submitted"
  }

  private async sampleResult(id: string, alreadyDone: boolean): Promise<SampleResult> {
    const row = await this.repository.findApplication(id)
    if (!row) throw new ApiException("not_found")
    const activation = await this.repository.readActivation()
    const outcome = sampleOutcome(row)
    return {
      result: outcome === "not_submitted" ? await this.notSubmittedResult(id, alreadyDone) : outcome,
      alreadyDone,
      countingSamples: await this.repository.countingSamples(),
      gatePassedAt: activation.gate_passed_at?.toISOString() ?? null,
    }
  }
}

type ApplicationRow = Selectable<ApplicationTable> & { submitted_local_day: string | null; queued_for_local_day: string | null }

/** v1.24.0 (AA-3.2): the approval's posting check. `excluded` first, then an override, then not ranked; null approves. */
function approvalRefusal(status: string, overrideRecorded: boolean): "excluded" | "not_allowed" | "not_ranked" | null {
  if (status === "excluded") return "excluded"
  if (overrideRecorded) return "not_allowed"
  return status === "ranked" ? null : "not_ranked"
}

function sampleOutcome(row: ApplicationRow): SampleResult["result"] {
  // Approved, waiting for the worker's job (F-QA5-01).
  if (row.sample_state === "approved" && row.submission_state === null) return "pending"
  switch (row.submission_state) {
    case "confirmed":
      return "confirmed"
    case "uncertain":
      return "uncertain"
    case "blocked":
      return row.blocked_reason === "same_company_review" ? "held" : "blocked"
    default:
      return "not_submitted"
  }
}

function reasonText(reason: string): string {
  const text = reason.trim()
  if (text === "") throw new ApiException("reason_empty")
  if (text.length > REASON_MAX) throw new ApiException("bad_request")
  return text
}

export function submissionOf(row: ApplicationRow, override: ApplicationOverride | null): Submission {
  const iso = (value: Date | null) => value?.toISOString() ?? null
  return {
    state: row.submission_state,
    kind: row.submission_kind,
    attemptNumber: row.attempt_number,
    submittedAt: iso(row.submit_clicked_at),
    submittedWatDay: row.submitted_local_day,
    evidence:
      row.evidence_kind && row.confirmed_at ? { kind: row.evidence_kind, text: row.evidence_text, observedAt: row.confirmed_at.toISOString() } : null,
    captchaAfterSubmit: row.captcha_after_submit,
    blockedReason: row.blocked_reason,
    blockedSubReason: row.blocked_sub_reason,
    blockedDetail: row.blocked_detail,
    blockedQuestion: row.blocked_question,
    blockedAt: iso(row.blocked_at),
    queuedForWatDay: row.queued_for_local_day,
    sample: row.sample_state ? { state: row.sample_state, rejectReason: row.sample_reject_reason, counts: row.sample_counts } : null,
    declinedReason: row.declined_reason,
    declinedAt: iso(row.declined_at),
    markedNotSubmittedAt: iso(row.marked_not_submitted_at),
    manualCompletedAt: iso(row.manual_completed_at),
    override,
  }
}

function existingOf(row: Selectable<ExistingApplicationTable>): ExistingApplication {
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.role_title,
    applicationUrl: row.application_url,
    requisitionId: row.requisition_id,
    appliedOn: row.applied_on,
    createdAt: row.created_at.toISOString(),
  }
}
