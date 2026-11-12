import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import { CandidateScope } from "../db/candidate-scope.js"
import type { QueuedPostingDroppedDetail, SamplePostingDroppedDetail } from "@eve/contracts"

import type { BlockedReason, BlockedSubReason, EvidenceKind } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { normaliseApplicationUrl } from "../discovery/application-url.js"
import { tierMapIn } from "../discovery/tier-map.js"
import { sharePreferences } from "../preferences/preferences-lock.js"
import { readPreferences } from "../preferences/preferences-read.js"
import type { AnswerSources } from "./answer-assignment.js"
import { roleLocationOf, workContextOf } from "./work-context.js"
import { eligibilityPreferencesOf } from "../discovery/rules/eligibility.js"
import { recheckEligibility } from "./eligibility-recheck.js"
import type { FormControl } from "./form-session.js"
import { visibilityFactsOf } from "../discovery/discovery.repository.js"
import { hiddenReason, visibilityContext } from "../discovery/visibility.js"
import { dropDetail } from "../documents/override.js"
import { postingState } from "../documents/override-reader.js"

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

type Db = CandidateTx

/** The Candidate whose `CandidateTx` a method runs in (`forCandidate` sets the scope with the setting). */
const cid = (): string => CandidateScope.require()

/**
 * EPIC-0002 A1: the scope's Candidate's Applications, submission days, events,
 * existing applications, activation state and outbox rows. Every statement runs
 * in a `CandidateTx` and names its `candidate_id`; methods that take a `db`
 * run inside the caller's `run` transaction. `job_posting` and `control_state`
 * are shared tables; a posting's status, origin and discovery time are the
 * Candidate's `candidate_posting` row (item 6). Submission is Operator only until slice E.
 */
@Injectable()
export class SubmissionRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** One transaction for the scope's Candidate (replaces the raw `database` handle). */
  run<T>(work: (tx: CandidateTx, candidateId: string) => Promise<T>): Promise<T> {
    return this.tenant.run(work)
  }

  findApplication(id: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .selectAll()
        .select((eb) => [eb.cast<string | null>("submitted_local_day", "text").as("submitted_local_day"), eb.cast<string | null>("queued_for_local_day", "text").as("queued_for_local_day")])
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .executeTakeFirst()
    )
  }

  findPostingForApplication(applicationId: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
        .innerJoin("candidate_posting", (join) => join.onRef("candidate_posting.job_posting_id", "=", "job_posting.id").on("candidate_posting.candidate_id", "=", candidateId))
        .select(["job_posting.id", "job_posting.apply_url", "job_posting.application_url", "candidate_posting.status", "job_posting.apply_mode", "job_posting.application_system"])
        .where("application.candidate_id", "=", candidateId)
        .where("application.id", "=", applicationId)
        .executeTakeFirst()
    )
  }

  findDocuments(applicationId: string) {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("tailored_document").select(["kind", "pdf_storage_name"]).where("candidate_id", "=", candidateId).where("application_id", "=", applicationId).execute()
    )
  }

  readControl() {
    return this.tenant.run((tx) => tx.selectFrom("control_state").select(["global_paused", "cost_paused"]).executeTakeFirstOrThrow())
  }

  readActivation() {
    return this.tenant.run((tx, candidateId) => tx.selectFrom("activation_state").selectAll().where("candidate_id", "=", candidateId).executeTakeFirstOrThrow())
  }

  /**
   * One transaction, statements in turn: a pooled Promise.all would need four connections.
   * EPIC-0002 B1: the work context comes from the Candidate's Job Preferences
   * (never `candidate_setting.work_authorization`), and the role location from
   * the Application's stored Eligibility result.
   */
  answerSources(applicationId: string) {
    return this.tenant.run(async (tx, candidateId) => {
      const contact = (await tx.selectFrom("candidate_contact").select(["full_name", "lines"]).where("candidate_id", "=", candidateId).executeTakeFirst()) ?? { full_name: "", lines: [] as string[] }
      const preferences = await readPreferences(tx, candidateId)
      const eligibility = await tx
        .selectFrom("application")
        .innerJoin("eligibility_result as e", (join) => join.onRef("e.job_posting_id", "=", "application.job_posting_id").on("e.candidate_id", "=", candidateId))
        .select(["e.arrangement", "e.relocation_country", "e.rules"])
        .where("application.candidate_id", "=", candidateId)
        .where("application.id", "=", applicationId)
        .executeTakeFirst()
      const answers = await tx.selectFrom("approved_answer").select(["answer_group", "topic", "skill", "question", "value"]).where("candidate_id", "=", candidateId).execute()
      const salaries = await tx.selectFrom("gross_salary_answer").select(["kind", "amount", "currency", "period"]).where("candidate_id", "=", candidateId).execute()
      return { contact, preferences, eligibility: eligibility ?? null, answers, salaries }
    })
  }

  /** The Candidate's answers, salary and work context in the shape answer assignment reads, for one Application. */
  async loadAnswerSources(applicationId: string): Promise<AnswerSources> {
    const { contact, preferences, eligibility, answers, salaries } = await this.answerSources(applicationId)
    const salary = (kind: "gross_salary_policy" | "current_salary") => {
      const row = salaries.find((item) => item.kind === kind)
      return row ? { amount: row.amount, currency: row.currency, period: row.period } : null
    }
    return {
      fullName: contact.full_name,
      contactLines: contact.lines,
      // No record (STEP3_DEFAULTS has no home country): null, so every work question blocks.
      work: preferences === null ? null : workContextOf(preferences.values),
      roleLocation: roleLocationOf(eligibility),
      answers: answers.map((row) => ({ group: row.answer_group, topic: row.topic, skill: row.skill, question: row.question, value: row.value })),
      grossSalaryPolicy: salary("gross_salary_policy"),
      currentSalary: salary("current_salary"),
    }
  }

  /**
   * Replaces the recorded form controls for one Application. False, and nothing
   * stored, when the Application's details were deleted while the form was read (SEC-701).
   */
  async saveFormRead(applicationId: string, host: string, controls: readonly FormControl[], at: Date): Promise<boolean> {
    const stored = JSON.stringify(
      controls.map(({ ref, label, kind, required, options, fieldName, fieldId, schemaQuestion }) => ({
        ref,
        label,
        kind,
        required,
        ...(options ? { options: [...options] } : {}),
        ...(fieldName ? { fieldName } : {}),
        ...(fieldId ? { fieldId } : {}),
        ...(schemaQuestion ? { schemaQuestion: { text: schemaQuestion.text, fieldName: schemaQuestion.fieldName, ...(schemaQuestion.options ? { options: [...schemaQuestion.options] } : {}) } } : {}),
      }))
    )
    return this.tenant.run(async (trx, candidateId) => {
      if (!(await this.isLive(trx, applicationId))) return false
      await trx
        .insertInto("application_form_read")
        .values({ candidate_id: candidateId, application_id: applicationId, host, controls: stored, read_at: at })
        .onConflict((oc) => oc.column("application_id").doUpdateSet({ host, controls: stored, read_at: at }))
        .execute()
      return true
    })
  }

  /** Locks the Application row against deletion (which takes it FOR UPDATE) and says whether its details are still there. */
  private async isLive(db: Db, applicationId: string): Promise<boolean> {
    const row = await db.selectFrom("application").select("details_deleted_at").where("candidate_id", "=", cid()).where("id", "=", applicationId).forShare().executeTakeFirst()
    return row !== undefined && row.details_deleted_at === null
  }

  async logEvent(applicationId: string | null, kind: string, detail: string | null, at: Date, db?: Db): Promise<void> {
    const write = (tx: Db, candidateId: string) => tx.insertInto("submission_event").values({ id: randomUUID(), candidate_id: candidateId, application_id: applicationId, kind, detail, created_at: at }).execute()
    await (db ? write(db, cid()) : this.tenant.run(write))
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
      if (kind === "automatic") await this.shareCriteria(trx)
      const app = await trx.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).where("id", "=", applicationId).forUpdate().executeTakeFirst()
      if (!app) return { refused: "not_claimable" as const }
      // v1.27.0 (PD-4.1, PD-4.2): a manual-only Application is never claimed; nothing counts toward the cap or the gate.
      if (await this.manualOnly(trx, app)) return { refused: "not_claimable" as const }
      const claimable = kind === "sample" ? app.sample_state === "approved" && app.submission_state === null : app.submission_state === "queued"
      // AC 10.3: an Application whose detailed records were deleted is a minimal record; it is never submitted.
      if (!claimable || app.state !== "documents_ready" || app.details_deleted_at !== null) return { refused: "not_claimable" as const }
      if (kind === "automatic" && (await this.dropUnlessSubmittable(trx, applicationId, at))) return { refused: "posting_closed" as const }
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
   * The ATS minimum check (0030): the Application's resume ATS score and the Candidate's minimum, or null
   * when there is nothing to check (a resume written before ATS scoring, or a minimum of 0, the gate off).
   * A Candidate without a settings row has the default minimum, 40.
   */
  async atsGate(applicationId: string): Promise<Readonly<{ score: number; minimum: number }> | null> {
    return this.tenant.run(async (tx, candidateId) => {
      const resume = await tx
        .selectFrom("tailored_document")
        .select(sql<number | null>`(content->'ats'->>'score')::int`.as("score"))
        .where("candidate_id", "=", candidateId)
        .where("application_id", "=", applicationId)
        .where("kind", "=", "resume")
        .executeTakeFirst()
      const setting = await tx.selectFrom("candidate_setting").select("min_ats_percent").where("candidate_id", "=", candidateId).executeTakeFirst()
      const minimum = setting?.min_ats_percent ?? 40
      if (resume?.score === null || resume?.score === undefined || minimum === 0) return null
      return { score: resume.score, minimum }
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
   * Queued automatic Applications with what ranking needs (AC 6.2: carried-over
   * Applications are re-ranked with the day's new ones).
   */
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
      if (Number(result.numUpdatedRows) === 1) await this.logEvent(applicationId, await this.dropKind(tx, applicationId, detail, eligibilityChanged), detail, at, tx)
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
      await this.shareCriteria(trx)
      const app = await trx.selectFrom("application").select("submission_state").where("candidate_id", "=", candidateId).where("id", "=", applicationId).forUpdate().executeTakeFirst()
      if (app?.submission_state !== "queued") return false
      return this.dropUnlessSubmittable(trx, applicationId, at)
    })
  }

  /**
   * Sets CLAIM_TIMEOUTS, then takes the scope's Candidate's Job Preferences
   * row and then Job criteria row FOR SHARE (EPIC-0002 B1): the lock order of architecture.r1 and r6 (criteria first, before any
   * posting or Application row), as the save, the evaluator and the create
   * (SEC-003) take it. A save that is re-deciding postings finishes first, so
   * the posting read after this shows the committed decision; a save that
   * starts later waits for this commit.
   */
  private async shareCriteria(trx: Db): Promise<void> {
    await applyTransactionTimeouts(trx, CLAIM_TIMEOUTS)
    // EPIC-0002 B1 lock order: the Job Preferences row FOR SHARE first, then job_criteria FOR SHARE.
    await sharePreferences(trx, cid())
    await trx.selectFrom("job_criteria").select("version").where("candidate_id", "=", cid()).forShare().executeTakeFirstOrThrow()
  }

  /**
   * Drops the queued Application, in `trx`, when its posting is not submittable
   * for the scope's Candidate. Call under the criteria share lock.
   */
  private async dropUnlessSubmittable(trx: Db, applicationId: string, at: Date): Promise<boolean> {
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
      .select(["job_posting_id", "candidate_override_at", "override_created_at", "override_status", "override_skip_reason", "override_skip_detail", "override_violated_rules", "details_deleted_at"])
      .where("candidate_id", "=", candidateId)
      .where("id", "=", applicationId)
      .executeTakeFirst()
    if (!app) return "not_ranked"
    const state = await postingState(trx, candidateId, app.job_posting_id, at)
    return dropDetail(app, state)
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
  private async dropOf(trx: Db, applicationId: string, at: Date): Promise<{ detail: QueuedPostingDroppedDetail; eligibilityChanged: boolean } | null> {
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
      await this.shareCriteria(trx)
      if (kind === "sample") return this.markSampleSubmitting(trx, candidateId, applicationId, attemptId, at)
      const app = await trx
        .selectFrom("application")
        .select(["attempt_id", "submission_state"])
        .where("candidate_id", "=", candidateId)
        .where("id", "=", applicationId)
        .forUpdate()
        .executeTakeFirst()
      if (app?.attempt_id !== attemptId || app.submission_state !== "submit_claimed") return "not_claimable" as const
      const drop = await this.dropOf(trx, applicationId, at)
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
    await this.logEvent(applicationId, await this.dropKind(trx, applicationId, detail, eligibilityChanged), detail, at, trx)
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
  private async dropKind(trx: Db, applicationId: string, detail: QueuedPostingDroppedDetail, eligibilityChanged: boolean): Promise<"queued_posting_preferences_changed" | "queued_posting_dropped"> {
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
    if (!(await this.isLive(db, applicationId))) return
    // Slice 6: one success email per Application (unique index), so a second confirmation adds no row.
    await db
      .insertInto("notification_outbox")
      .values({ id: randomUUID(), candidate_id: cid(), application_id: applicationId, kind, created_at: at, sent_at: null, status: kind === "uncertain" ? "skipped" : "pending" })
      .onConflict((oc) => oc.column("application_id").where("kind", "=", "confirmed").doNothing())
      .execute()
  }
}

/** First key of the two-key advisory lock that serialises one company's claims (SEC-503). */
export const COMPANY_LOCK_NAMESPACE = 72_006

/** Second key: a stable 32-bit hash of the trimmed, lower-cased company name (the same comparison the check uses). */
export function companyLockKey(company: string): number {
  let hash = 0
  for (const char of company.trim().toLowerCase()) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return hash
}

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
