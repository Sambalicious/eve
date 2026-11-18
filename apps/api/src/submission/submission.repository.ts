import { Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import type { QueuedPostingDroppedDetail } from "@eve/contracts"

import type { BlockedReason, BlockedSubReason, EvidenceKind, SubmissionState } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { normaliseApplicationUrl, isWebUrl, locateAts } from "../discovery/application-url.js"
import { readPreferences } from "../preferences/preferences-read.js"
import type { AnswerSources } from "./answer-assignment.js"
import { roleLocationOf, workContextOf } from "./work-context.js"
import type { FormControl } from "./form-session.js"
import { SubmissionAttemptsRepository, isLive } from "./submission-attempts.repository.js"
import type { ClaimRefusal, Db } from "./submission-attempts.repository.js"
import { SubmissionQueueRepository } from "./submission-queue.repository.js"

/**
 * The claim, the outcome writes and the daily counts live in
 * `submission-attempts.repository.ts`; the queued-Application rules and the
 * sample returns in `submission-queue.repository.ts`. This class keeps every
 * entry point and delegates, and re-exports what callers import from here.
 */
export { ACTIVE_STATES, CLAIM_TIMEOUTS, COMPANY_LOCK_NAMESPACE, DAILY_CAP, companyLockKey } from "./submission-attempts.repository.js"
export { isRulesDrop } from "./submission-queue.repository.js"
export type { ClaimRefusal } from "./submission-attempts.repository.js"

/**
 * ADR 0016: the submission states a fill may touch. Only `blocked`, where the automatic path gave up and the
 * Candidate is applying by hand. A `queued` Application is left out on purpose: the worker could submit it while
 * the Candidate fills it by hand, and that duplicate is worse than no fill.
 */
const FILLABLE_SUBMISSION_STATES: readonly SubmissionState[] = ["blocked"]

/** A job board's own requisition query parameter, which `normaliseApplicationUrl` strips as tracking. */
function jobIdParam(raw: string): string | null {
  try {
    return new URL(raw).searchParams.get("gh_jid")
  } catch {
    return null
  }
}

/** The Application a page matched, as ADR 0016 may show it (no page or Candidate state). */
export type MatchedApplicationRow = Readonly<{ id: string; company: string | null; role_title: string | null }>

/**
 * EPIC-0002 A1: the scope's Candidate's Applications, answers, form reads and
 * ATS gate. Every statement runs in a `CandidateTx` and names its
 * `candidate_id`; methods that take a `db` run inside the caller's `run`
 * transaction. `job_posting` and `control_state` are shared tables; a
 * posting's status, origin and discovery time are the Candidate's
 * `candidate_posting` row (item 6). Submission is Operator only until slice E.
 */
@Injectable()
export class SubmissionRepository {
  private readonly attempts: SubmissionAttemptsRepository
  private readonly queue: SubmissionQueueRepository

  constructor(private readonly tenant: TenantDatabase) {
    this.queue = new SubmissionQueueRepository(tenant)
    this.attempts = new SubmissionAttemptsRepository(tenant, this.queue)
  }

  /** One transaction, scoped to the scope's Candidate. */
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
   * ADR 0016 matching: the Candidate's own Application for a page the extension
   * read, or null. The stored URL is compared in the same normalised form the
   * write path uses: an exact normalised URL first, then the ATS identity the
   * URL names (so Lever `/apply`, Ashby `/application` and a Greenhouse board
   * host redirect all match), and only then a unique host+path row whose stored
   * query is empty.
   *
   * A host+path match is never a guess: two Applications on one page (or one
   * page served on a different port), or one whose stored URL carries a query,
   * answer null rather than binding a sponsorship answer or a later
   * manual-complete to the wrong Application. Only an Application that can still
   * be applied to is eligible: `documents_ready`, with no submission or a
   * `blocked` one. A queued Application is excluded so a manual fill cannot race
   * the worker; a confirmed, manual, declined, not_submitted or uncertain one is
   * never filled again. The SQL host prefilter keeps
   * this from reading every Application the Candidate owns.
   */
  async matchApplication(pageUrl: string): Promise<MatchedApplicationRow | null> {
    if (!isWebUrl(pageUrl)) return null
    // A page served over plain http can be rewritten in transit; only a local form is filled over http.
    const rawPage = new URL(pageUrl)
    if (rawPage.protocol === "http:" && rawPage.hostname !== "localhost" && rawPage.hostname !== "127.0.0.1") return null
    const wanted = normaliseApplicationUrl(pageUrl)
    const wantedUrl = new URL(wanted)
    const wantedAts = locateAts(wanted)
    const hostFragments = new Set<string>([`://${wantedUrl.hostname}`, `://www.${wantedUrl.hostname}`])
    if (wantedAts !== null) hostFragments.add(atsHostFragment(wantedAts.system))
    return this.tenant.run(async (tx, candidateId) => {
      const rows = await tx
        .selectFrom("application")
        .select(["id", "application_url", "company", "role_title"])
        .where("candidate_id", "=", candidateId)
        // A minimal record has no details left to fill from; it is not an Application the Candidate can apply through.
        .where("details_deleted_at", "is", null)
        // ADR 0016: only an Application that can still be applied to is filled, and only when nothing can race
        // the Candidate: no submission, or the blocked state where the automatic path already gave up.
        .where("state", "=", "documents_ready")
        .where((eb) => eb.or([eb("submission_state", "is", null), eb("submission_state", "in", FILLABLE_SUBMISSION_STATES)]))
        .where((eb) => eb.or([...hostFragments].map((fragment) => eb("application_url", "like", `%${fragment}%`))))
        .orderBy("created_at", "desc")
        .execute()
      const matched = (row: (typeof rows)[number]): MatchedApplicationRow => ({ id: row.id, company: row.company, role_title: row.role_title })
      const exact: typeof rows = []
      const byAts: typeof rows = []
      for (const row of rows) {
        if (!isWebUrl(row.application_url)) continue
        const stored = normaliseApplicationUrl(row.application_url)
        // `gh_jid` is stripped as a tracking parameter, so two jobs on one careers page normalise alike. Exactness
        // must include it: the page and the stored URL have to name the same requisition.
        if (stored === wanted && jobIdParam(row.application_url) === jobIdParam(pageUrl)) {
          exact.push(row)
          continue
        }
        if (wantedAts === null) continue
        const storedAts = locateAts(stored)
        if (storedAts === null || storedAts.system !== wantedAts.system || storedAts.board !== wantedAts.board || storedAts.jobId !== wantedAts.jobId) continue
        byAts.push(row)
      }
      // An exact URL is only usable when exactly one Application owns it; two rows on one URL are ambiguous.
      if (exact.length === 1) return matched(exact[0]!)
      if (exact.length > 1) return null
      if (byAts.length === 1) return matched(byAts[0]!)
      if (byAts.length > 1) return null
      const samePage = rows.filter((row) => {
        if (!isWebUrl(row.application_url)) return false
        const storedUrl = new URL(normaliseApplicationUrl(row.application_url))
        return (
          storedUrl.hostname === wantedUrl.hostname &&
          storedUrl.port === wantedUrl.port &&
          storedUrl.pathname === wantedUrl.pathname &&
          // The stripped requisition parameter still decides: two jobs on one careers page are not one Application.
          jobIdParam(row.application_url) === jobIdParam(pageUrl)
        )
      })
      if (samePage.length !== 1) return null
      const only = samePage[0]!
      const storedUrl = new URL(normaliseApplicationUrl(only.application_url))
      return storedUrl.search === "" ? matched(only) : null
    })
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
      if (!(await isLive(trx, applicationId))) return false
      await trx
        .insertInto("application_form_read")
        .values({ candidate_id: candidateId, application_id: applicationId, host, controls: stored, read_at: at })
        .onConflict((oc) => oc.column("application_id").doUpdateSet({ host, controls: stored, read_at: at }))
        .execute()
      return true
    })
  }

  logEvent(applicationId: string | null, kind: string, detail: string | null, at: Date, db?: Db): Promise<void> {
    return this.attempts.logEvent(applicationId, kind, detail, at, db)
  }

  /**
   * The claim (architecture r1 journey 2 step 5), in one transaction: lock the
   * Application row and today's `submission_day` row, re-check pause, gate,
   * duplicates, same company and the cap, then set `submit_claimed` with a new
   * attempt ID. Automatic claims count against the cap; samples do not.
   */
  claim(applicationId: string, kind: "automatic" | "sample", day: string, at: Date): Promise<{ attemptId: string } | { refused: ClaimRefusal }> {
    return this.attempts.claim(applicationId, kind, day, at)
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
  automaticCount(db: Db, day: string): Promise<number> {
    return this.attempts.automaticCount(db, day)
  }

  countForDay(day: string): Promise<number> {
    return this.attempts.countForDay(day)
  }

  /** CR5-05: stored URLs are normalised on write (and by migration 0008), so the lookup normalises its side the same way. */
  isExistingApplication(db: Db, applicationUrl: string, requisitionId: string): Promise<boolean> {
    return this.attempts.isExistingApplication(db, applicationUrl, requisitionId)
  }

  hasOtherActiveAtCompany(db: Db, applicationId: string, company: string | null): Promise<boolean> {
    return this.attempts.hasOtherActiveAtCompany(db, applicationId, company)
  }

  /** Queued Applications with their ranking inputs, and the Candidate's tier map (EPIC-0002 B1), read in one transaction. */
  queuedForRanking() {
    return this.queue.queuedForRanking()
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
    await this.queue.dropQueued(applicationId, detail, at, db, eligibilityChanged)
  }

  /**
   * The unlocked early check (`submit`): the drop detail when the queued
   * Application's posting is not submittable, else null. The claim repeats it
   * under the criteria share lock.
   */
  dropDetailUnlocked(applicationId: string, at: Date): Promise<QueuedPostingDroppedDetail | null> {
    return this.queue.dropDetailUnlocked(applicationId, at)
  }

  /**
   * SEC-014 (AC 5.8): the pre-submission status check, made atomic. Under the
   * Job criteria share lock, a queued automatic Application whose posting is
   * no longer ranked for the scope's Candidate is dropped exactly as the
   * unlocked check drops it. True when it was dropped. Runs after the browser
   * lease is held and before any page opens; `claim` repeats it for the time
   * the page is open.
   */
  dropQueuedUnlessRanked(applicationId: string, at: Date): Promise<boolean> {
    return this.queue.dropQueuedUnlessRanked(applicationId, at)
  }

  /**
   * v1.27.0 (EPIC-0010 PD-4.1): the Application's posting has `apply_mode = 'manual'`, or it was made from a
   * pasted description (synthetic `pasted:` requisition, manual even after its posting is gone).
   */
  manualOnly(trx: Db, app: Readonly<{ job_posting_id: string; requisition_id: string }>): Promise<boolean> {
    return this.queue.manualOnly(trx, app)
  }

  /**
   * EPIC-0006 (AC-3.9): the posting is hidden for `candidateId` at `at`, with
   * the visibility context read from their criteria row FOR SHARE in `trx`. A
   * posting they do not hold reads as hidden (fail-closed).
   */
  postingHiddenFor(trx: Db, candidateId: string, postingId: string, at: Date): Promise<boolean> {
    return this.queue.postingHiddenFor(trx, candidateId, postingId, at)
  }

  /** Nothing was sent for an approved sample: it waits for the Candidate's review again (C-SAMPLE-13). */
  returnSampleToReview(applicationId: string, at: Date): Promise<void> {
    return this.queue.returnSampleToReview(applicationId, at)
  }

  /**
   * Approved samples with no submission and no job waiting in `queue` (the
   * worker stopped before claiming). Run at worker start, before jobs are
   * taken, so no job of this worker is running. The scope's Candidate's rows only.
   */
  returnLostSamplesToReview(queue: string, at: Date): Promise<number> {
    return this.queue.returnLostSamplesToReview(queue, at)
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
  markSubmitting(applicationId: string, attemptId: string, kind: "automatic" | "sample", at: Date): Promise<"submitting" | "posting_closed" | "not_claimable"> {
    return this.attempts.markSubmitting(applicationId, attemptId, kind, at)
  }

  /** Releases a claim before the click (pause): nothing was submitted, so the Application returns to where it was. */
  releaseClaim(applicationId: string, attemptId: string, kind: "automatic" | "sample", at: Date): Promise<void> {
    return this.attempts.releaseClaim(applicationId, attemptId, kind, at)
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
    await this.attempts.block(applicationId, attemptId, block, at, kind)
  }

  /** Journey 2 step 10: Confirmed or Uncertain, with the outbox row in the same transaction. Never retried. */
  async finish(
    applicationId: string,
    attemptId: string,
    result: Readonly<{ evidence: { kind: EvidenceKind; text: string } | null; captchaAfterSubmit: boolean; coverLetterUploaded: boolean | null }>,
    at: Date
  ): Promise<void> {
    await this.attempts.finish(applicationId, attemptId, result, at)
  }

  /** AC 2.4: the gate passes once, when the Career Profile is approved, existing applications are complete and five samples count. */
  passGateIfReady(db: Db, at: Date): Promise<void> {
    return this.attempts.passGateIfReady(db, at)
  }

  countingSamples(db?: Db): Promise<number> {
    return this.attempts.countingSamples(db)
  }

  /** ADR 0005: after a crash, the scope's Candidate's claims or clicks in flight become Uncertain and are never re-queued. */
  recoverInterrupted(at: Date): Promise<number> {
    return this.attempts.recoverInterrupted(at)
  }

  outbox(db: Db, applicationId: string, kind: "confirmed" | "blocked" | "uncertain", at: Date): Promise<void> {
    return this.attempts.outbox(db, applicationId, kind, at)
  }
}

/** The ATS domain a stored URL may use instead of the page's own host (Greenhouse board redirects, Lever/Ashby hosts). */
function atsHostFragment(system: "greenhouse" | "lever" | "ashby"): string {
  return { greenhouse: "greenhouse.io", lever: "lever.co", ashby: "ashbyhq.com" }[system]
}
