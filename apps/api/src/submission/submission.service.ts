
import { Inject, Injectable, Logger } from "@nestjs/common"

import type { BlockedReason, BlockedSubReason } from "../db/schema.js"
import { CandidateScope } from "../db/candidate-scope.js"
import { TenantDatabase } from "../db/tenant-database.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { isLockTimeout } from "../discovery/discovery.repository.js"
import { SPEND_CONFIG } from "../spend/spend-config.js"
import { SpendLedger } from "../spend/spend-ledger.js"
import type { SpendConfig } from "../spend/spend-math.js"
import { type AnswerSources, type FieldAnswer, type FormField, type SchemaQuestion, answerFor, answeredWorkFields, assignAnswers, blockedQuestion, planAnswers } from "./answer-assignment.js"
import { BrowserMutex } from "./browser-mutex.js"
import { FormAgentRunner } from "./form-agent/form-agent-runner.js"
import { FORM_SESSION_FACTORY, type EvidenceStage, type FormRead, type FormSession, type FormSessionFactory, OffOriginError, type PageAfterSubmit } from "./form-session.js"
import { rankApplications } from "./rank-applications.js"
import { captchaVisible, detectPageBlock, judgeResult } from "./page-rules.js"
import { QUESTION_SCHEMAS, type QuestionSchemaSource, attachSchema } from "./question-schema.js"
import { type ClaimRefusal, DAILY_CAP, SubmissionRepository } from "./submission.repository.js"
import { nextWatDay, watDay } from "./wat-day.js"
import { CandidateFiles } from "../files/candidate-files.js"
import { type StoredDocument, storedDocument } from "./stored-document.js"

export type DailyRunSummary = Readonly<{
  submitted: number
  carriedOver: number
  stoppedBy: "gate_not_passed" | "automatic_disabled" | "paused" | "cap_reached" | null
}>

export type SubmitOutcome =
  | Readonly<{ result: "confirmed" | "uncertain" | "blocked" }>
  | Readonly<{ result: "refused"; refusal: ClaimRefusal | "browser_unavailable" | "not_ready" | "posting_closed" }>

class PausedError extends Error {}
/** SEC-017: the claim was released after a 55P03 before the click; the original error goes up unchanged. */
class LockTimeoutBeforeClick extends Error {
  constructor(readonly original: unknown) {
    super("lock timeout before the click")
  }
}
class IncompleteError extends Error {
  constructor(
    readonly subReason: BlockedSubReason | null,
    readonly detail: string
  ) {
    super(detail)
  }
}

const INCOMPLETE_DETAIL = {
  redirect: (host: string | null) =>
    host
      ? `The form sent the browser to ${host}, which isn't the employer's application site.`
      : "The form sent the browser away from the employer's application site.",
  submitAttempt: "Something on the page tried to submit the form early. The assistant stopped it.",
  fieldChanged: (label: string | null) =>
    label ? `The "${label}" question changed on the page after it was answered, so it didn't submit.` : "A question changed on the page after it was answered, so it didn't submit.",
  mismatch: (label: string | null) =>
    label ? `The "${label}" field didn't hold the value the assistant set, so it didn't submit.` : "A field didn't hold the value the assistant set, so it didn't submit.",
  noSubmitControl: "The assistant couldn't find exactly one submit button on the form.",
  budget: "It used up its time or effort limit for this form before every field was filled.",
}

/**
 * One submission attempt (architecture r1 journey 2, ADR 0005, ADR 0008).
 * Backend code reads the form, detects blocks, assigns answers, claims a slot,
 * fills, verifies every value, commits `submitting`, clicks submit once, and
 * parses the result. Global pause is checked before the claim and after every
 * browser call until `submitting` is committed. There is no retry path.
 *
 * Deterministic-first: code fills every field it can answer; only required
 * free-text questions with no matching Approved Answer go to the form agent,
 * only when SUBMISSION_FORM_AGENT_ENABLED=1 (off by default) and an AI provider
 * is approved. Choice fields never go to the agent (repair wave 3, SEC-515). A leftover the agent leaves empty
 * blocks as Missing Approved Answer; an exhausted agent budget blocks with the
 * seventh reason's `budget` sub-reason.
 */
@Injectable()
export class SubmissionService {
  private readonly logger = new Logger(SubmissionService.name)

  constructor(
    private readonly repository: SubmissionRepository,
    @Inject(FORM_SESSION_FACTORY) private readonly sessions: FormSessionFactory,
    private readonly formAgent: FormAgentRunner,
    private readonly files: CandidateFiles,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly mutex: BrowserMutex,
    @Inject(QUESTION_SCHEMAS) private readonly schemas: QuestionSchemaSource,
    private readonly ledger: SpendLedger,
    @Inject(SPEND_CONFIG) private readonly spend: SpendConfig,
    private readonly tenant: TenantDatabase
  ) {}

  /**
   * ADR 0005 crash recovery, called by the worker only (SEC-508): claims and
   * clicks in flight become Uncertain Submissions and are never re-queued. It
   * runs only while no browser session holds the browser lease, so a live
   * attempt in this or another worker process is never touched. The api
   * process never calls it.
   * EPIC-0002 A1: system work; each Candidate's rows are recovered in that
   * Candidate's scope, all under the one browser lease.
   */
  async recoverInterrupted(): Promise<number | "lease_held"> {
    return this.mutex.ifFree(async () => {
      const counts = await this.tenant.eachCandidate(() => this.repository.recoverInterrupted(this.clock.now()))
      return counts.reduce((sum, count) => sum + count, 0)
    })
  }

  /**
   * The day's automatic submissions (journey 2; queue concurrency 1, no
   * retries). Queued Applications are re-ranked with the shared ranking and
   * attempted in order until the cap refuses one; every remaining one is
   * carried to the next WAT day (AC 6.1, 6.2). Each attempt re-checks pause,
   * gate and cap inside its own claim, so a re-run never exceeds the cap.
   */
  async runDaily(): Promise<DailyRunSummary> {
    const activation = await this.repository.readActivation()
    if (activation.gate_passed_at === null) return { submitted: 0, carriedOver: 0, stoppedBy: "gate_not_passed" }
    if (!activation.automatic_enabled) return { submitted: 0, carriedOver: 0, stoppedBy: "automatic_disabled" }
    const { rows, tiers } = await this.repository.queuedForRanking()
    // Slice 8d (RF-27): the Ranked tab order under the Candidate's tiers (B1), tie broken on the posting id.
    const order = rankApplications(rows, tiers)
    let submitted = 0
    for (const [index, id] of order.entries()) {
      const outcome = await this.submit(id, "automatic")
      if (outcome.result === "confirmed" || outcome.result === "uncertain") submitted += 1
      if (outcome.result === "refused" && (outcome.refusal === "cap_reached" || outcome.refusal === "paused")) {
        const rest = order.slice(index + 1)
        if (outcome.refusal === "cap_reached") await this.carryOver(rest)
        return { submitted, carriedOver: outcome.refusal === "cap_reached" ? rest.length + 1 : 0, stoppedBy: outcome.refusal }
      }
    }
    return { submitted, carriedOver: 0, stoppedBy: null }
  }

  private async carryOver(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const now = this.clock.now()
    await this.repository.run((tx, candidateId) =>
      tx
        .updateTable("application")
        .set({ queued_for_local_day: nextWatDay(watDay(now)), updated_at: now })
        .where("candidate_id", "=", candidateId)
        .where("id", "in", ids)
        .where("submission_state", "=", "queued")
        .execute()
    )
  }

  /**
   * Runs one attempt for an Application. `automatic` needs a queued Application,
   * the passed gate and automatic submission on; `sample` needs an approved
   * sample and never counts against the cap.
   */
  async submit(applicationId: string, kind: "automatic" | "sample"): Promise<SubmitOutcome> {
    const now = this.clock.now()
    if (kind === "automatic") {
      const activation = await this.repository.readActivation()
      if (activation.gate_passed_at === null) {
        // AC 2.5: a pre-gate automatic attempt errors and is logged; no browser is opened.
        await this.repository.logEvent(applicationId, "automatic_refused_gate_not_passed", null, now)
        return { result: "refused", refusal: "gate_not_passed" }
      }
    }
    const app = await this.repository.findApplication(applicationId)
    const posting = await this.repository.findPostingForApplication(applicationId)
    if (!app || !posting || app.state !== "documents_ready" || posting.apply_mode !== "automatic") return { result: "refused", refusal: "not_ready" }
    if (kind === "automatic" && app.submission_state === "queued") {
      // AC 6.2 (EPIC-0004 prd.r2 AC 4.6, 5.6): a status check, not an evaluation. It makes no model call and
      // reads the stored decision, which every Job criteria save has already re-decided. v1.24.0 (AA-2.3 to 2.5):
      // a queued posting that is not submittable (not ranked and no applying override, hidden, or closed) returns
      // to documents ready. The locked checks repeat this; this unlocked pass only drops early.
      const detail = await this.repository.dropDetailUnlocked(applicationId, now)
      if (detail !== null) {
        await this.repository.dropQueued(applicationId, detail, now)
        return { result: "refused", refusal: "posting_closed" }
      }
    }
    // ATS minimum (0030): an automatic submission whose resume scores below the Candidate's minimum is held
    // in Blocked Applications before any page opens. Samples are the Candidate's own review, so not gated.
    if (kind === "automatic") {
      const ats = await this.repository.atsGate(applicationId)
      if (ats !== null && ats.score < ats.minimum) {
        return this.blockBeforeClaim(applicationId, kind, "ats_below_minimum", `ATS match ${ats.score}% is below your minimum of ${ats.minimum}%.`, null)
      }
    }
    const control = await this.repository.readControl()
    if (control.global_paused || control.cost_paused) return { result: "refused", refusal: "paused" }
    // The cap is re-checked under lock in the claim; this early check means a 6th attempt opens no page.
    if (kind === "automatic" && (await this.repository.countForDay(watDay(now))) >= DAILY_CAP) return this.refuse(applicationId, kind, "cap_reached", app.company)

    // SEC-503: one browser session at a time across every queue and process.
    const target = { applyUrl: posting.apply_url, applicationSystem: posting.application_system, company: app.company, previousAttemptId: app.attempt_id }
    return this.mutex.withLock(() => this.attempt(applicationId, kind, target))
  }

  private async attempt(
    applicationId: string,
    kind: "automatic" | "sample",
    target: Readonly<{ applyUrl: string; applicationSystem: string; company: string | null; previousAttemptId: string | null }>
  ): Promise<SubmitOutcome> {
    const { applyUrl, company, previousAttemptId } = target
    // SEC-014 (AC 5.8): the lease wait can take minutes. A save that skipped the posting meanwhile drops it here,
    // under the Job criteria lock, before any cost is reserved or page opened. Samples are not re-checked (O6).
    if (kind === "automatic" && (await this.repository.dropQueuedUnlessRanked(applicationId, this.clock.now()))) return { result: "refused", refusal: "posting_closed" }
    // Slice 7 (SEC-702): the browser's cost is reserved before the session opens the page. A refusal (global pause,
    // cost pause, or the ceiling) opens no page; nothing is claimed yet.
    const browserReservation = await this.reserveBrowser(applicationId, "browser_attempt")
    if (browserReservation === null) return { result: "refused", refusal: "paused" }
    let session: FormSession
    try {
      session = await this.sessions.create(previousAttemptId ?? applicationId)
    } catch {
      await this.ledger.release(browserReservation).catch(() => undefined)
      await this.repository.logEvent(applicationId, "browser_unavailable", null, this.clock.now())
      return { result: "refused", refusal: "browser_unavailable" }
    }
    const applicationHost = new URL(applyUrl).host
    let attemptId: string | null = null
    try {
      const page = await session.open(applyUrl)
      if (page.host !== applicationHost) throw new IncompleteError("redirect", INCOMPLETE_DETAIL.redirect(page.host))
      const pageBlock = detectPageBlock(page.text)
      if (pageBlock) return await this.blockBeforeClaim(applicationId, kind, pageBlock.reason, pageBlock.detail, null)
      const sources = await this.answerSources(applicationId)
      // Scope 05d: the employer's question schema, fetched by backend code outside the browser.
      const schema = await this.schemas.forPosting({ applicationSystem: target.applicationSystem, applyUrl })
      const controls = attachSchema(page.controls, schema)
      const plan = planAnswers(controls, sources)
      const agentReady = plan.block === null && plan.leftovers.length > 0 && (await this.formAgent.available())
      if (!agentReady) {
        // No agent: code alone decides, and the first unanswerable field in form order is the reason.
        const only = assignAnswers(controls, sources)
        if (only.block) return await this.blockBeforeClaim(applicationId, kind, only.block.reason, only.block.detail, blockedQuestion(only.block))
      }
      const assignment = { answers: [...plan.answers], coverLetterField: plan.coverLetterField }

      const claim = await this.repository.claim(applicationId, kind, watDay(this.clock.now()), this.clock.now())
      // SEC-014: the claim already dropped the queued Application and logged it, as the pre-submission check does.
      if ("refused" in claim && claim.refused === "posting_closed") return { result: "refused", refusal: "posting_closed" }
      if ("refused" in claim) return await this.refuse(applicationId, kind, claim.refused, company)
      attemptId = claim.attemptId

      const files = await this.storedDocuments(applicationId)
      for (const answer of plan.answers) {
        await this.fillOne(session, answer, files)
        await this.checkpoint(session, applicationHost)
      }
      if (agentReady) {
        const agent = await this.formAgent.run(applicationId, attemptId, {
          session,
          sources,
          leftovers: plan.leftovers,
          documents: files,
          // SEC-504: the text from `open`, before any fill.
          pageText: page.text,
          isPaused: async () => {
            const control = await this.repository.readControl()
            return control.global_paused || control.cost_paused
          },
        })
        await this.checkpoint(session, applicationHost)
        if (agent.stop === "paused") throw new PausedError()
        if (agent.stop === "budget") throw new IncompleteError("budget", INCOMPLETE_DETAIL.budget)
        assignment.answers.push(...agent.assigned)
        const unfilled = plan.leftovers.find((item) => !agent.assigned.some((answer) => answer.ref === item.field.ref))
        if (unfilled) {
          // submission.feature: a required field the agent leaves unfilled is a missing Approved Answer, not the seventh reason.
          await this.repository.block(applicationId, attemptId, { reason: unfilled.block.reason, detail: unfilled.block.detail, question: blockedQuestion(unfilled.block) }, this.clock.now())
          return { result: "blocked" }
        }
      }
      const work = { fields: answeredWorkFields(controls, sources), schema, sources }
      const textBeforeClick = await this.verify(session, applicationHost, assignment.answers, files, work)
      await this.saveEvidence(session, applicationId, "pre_submit")
      await this.checkpointPause()

      // Point of no return: committed before the click. A crash from here on gives Uncertain.
      const decision = await this.markSubmitting(applicationId, attemptId, kind)
      // SEC-017: a save skipped the posting after the claim. Dropped and logged, the slot freed; nothing is clicked.
      if (decision === "posting_closed") return { result: "refused", refusal: "posting_closed" }
      if (decision !== "submitting") return { result: "refused", refusal: "not_claimable" }
      try {
        await session.clickSubmit()
      } catch (error) {
        // Never repeated: the click may have reached the employer.
        this.logger.warn(`Submit click errored: ${error instanceof Error ? error.name : "unknown"}`)
      }
      const judge = (page: PageAfterSubmit) => judgeResult({ applicationHost, applicationSystem: target.applicationSystem, textBeforeClick, page })
      const after = await session.waitForResult((page) => judge(page).evidence !== null).catch((): PageAfterSubmit => ({ host: "", text: "", formPresent: false, validationErrors: false }))
      await this.saveEvidence(session, applicationId, "post_submit")
      const { evidence, offOriginHost } = judge(after)
      // SEC-502: off the application host after the click is Uncertain, with the host noted.
      if (offOriginHost !== null) await this.repository.logEvent(applicationId, "post_submit_off_origin", offOriginHost.slice(0, 255), this.clock.now())
      await this.repository.finish(
        applicationId,
        attemptId,
        { evidence, captchaAfterSubmit: !evidence && captchaVisible(after.text), coverLetterUploaded: assignment.coverLetterField },
        this.clock.now()
      )
      return { result: evidence ? "confirmed" : "uncertain" }
    } catch (caught) {
      // SEC-017: already released; rethrow the database error with nothing left to block.
      if (caught instanceof LockTimeoutBeforeClick) throw caught.original
      const error = caught instanceof OffOriginError ? new IncompleteError("redirect", INCOMPLETE_DETAIL.redirect(caught.host || null)) : caught
      if (error instanceof PausedError && attemptId !== null) {
        await this.repository.releaseClaim(applicationId, attemptId, kind, this.clock.now())
        return { result: "refused", refusal: "paused" }
      }
      if (error instanceof IncompleteError) {
        await this.repository.block(applicationId, attemptId, { reason: "automation_incomplete", subReason: error.subReason, detail: error.detail }, this.clock.now(), kind)
        return { result: "blocked" }
      }
      if (attemptId !== null) {
        // A browser error before the click: nothing was submitted.
        await this.repository.block(applicationId, attemptId, { reason: "automation_incomplete", subReason: null, detail: null }, this.clock.now())
        return { result: "blocked" }
      }
      throw error
    } finally {
      await session.close().catch(() => undefined)
      // The browser ran, so its reservation stands as the actual cost.
      await this.ledger.settle(browserReservation, this.spend.browserAttemptMicros).catch(() => undefined)
    }
  }

  /**
   * SEC-017: the locked re-check and the point of no return. A lock wait past
   * the 5 s lock_timeout (55P03) clicks nothing and writes nothing, so the
   * claim is released as a pause releases it: queued again, the slot freed,
   * picked up by the next run. The error is rethrown as a claim's 55P03 is
   * (SEC-018), with no claim left for the attempt's error handler to block.
   */
  private async markSubmitting(applicationId: string, attemptId: string, kind: "automatic" | "sample"): Promise<"submitting" | "posting_closed" | "not_claimable"> {
    try {
      return await this.repository.markSubmitting(applicationId, attemptId, kind, this.clock.now())
    } catch (error) {
      if (!isLockTimeout(error)) throw error
      await this.repository.releaseClaim(applicationId, attemptId, kind, this.clock.now())
      throw new LockTimeoutBeforeClick(error)
    }
  }

  /** One browser session's cost, reserved before it opens a page (SEC-702). Null when refused. */
  private async reserveBrowser(applicationId: string, purpose: "browser_attempt" | "browser_form_read"): Promise<string | null> {
    const reservation = await this.ledger.reserve({ category: "browser", purpose, estimateMicros: this.spend.browserAttemptMicros, action: "form filling", applicationId, haltOnGlobalPause: true })
    return reservation.ok ? reservation.id : null
  }

  /**
   * Reads a sample's application form without filling or clicking anything, and
   * records its controls (labels, kinds, required flags, options; never values)
   * so the sample review can show every planned answer (AC 2.1). Pause is
   * honoured; a page off the application host is not recorded.
   */
  async readForm(applicationId: string): Promise<"read" | "paused" | "not_ready" | "browser_unavailable" | "off_origin"> {
    const posting = await this.repository.findPostingForApplication(applicationId)
    if (!posting || posting.apply_mode !== "automatic") return "not_ready"
    const control = await this.repository.readControl()
    if (control.global_paused || control.cost_paused) return "paused"
    return this.mutex.withLock(() => this.readFormInSession(applicationId, posting.apply_url, posting.application_system))
  }

  private async readFormInSession(applicationId: string, applyUrl: string, applicationSystem: string): Promise<"read" | "paused" | "not_ready" | "browser_unavailable" | "off_origin"> {
    const browserReservation = await this.reserveBrowser(applicationId, "browser_form_read")
    if (browserReservation === null) return "paused"
    let session: FormSession
    try {
      session = await this.sessions.create(applicationId)
    } catch {
      await this.ledger.release(browserReservation).catch(() => undefined)
      return "browser_unavailable"
    }
    try {
      const page = await session.open(applyUrl)
      if (page.host !== new URL(applyUrl).host) return "off_origin"
      const schema = await this.schemas.forPosting({ applicationSystem, applyUrl })
      // SEC-701: details deleted while the form was read: nothing is stored.
      return (await this.repository.saveFormRead(applicationId, page.host, attachSchema(page.controls, schema), this.clock.now())) ? "read" : "not_ready"
    } catch (error) {
      if (error instanceof OffOriginError) return "off_origin"
      throw error
    } finally {
      await session.close().catch(() => undefined)
      await this.ledger.settle(browserReservation, this.spend.browserAttemptMicros).catch(() => undefined)
    }
  }

  /** Evidence files (snapshot, screenshot) are recorded by name; a failure to save never blocks or repeats the click. */
  private async saveEvidence(session: FormSession, applicationId: string, stage: EvidenceStage): Promise<void> {
    try {
      const files = await session.saveEvidence(stage)
      await this.repository.logEvent(applicationId, `evidence_${stage}`, files.join(","), this.clock.now())
    } catch {
      await this.repository.logEvent(applicationId, `evidence_${stage}_failed`, null, this.clock.now())
    }
  }

  private async blockBeforeClaim(applicationId: string, kind: "automatic" | "sample", reason: BlockedReason, detail: string, question: string | null): Promise<SubmitOutcome> {
    await this.repository.block(applicationId, null, { reason, detail, question }, this.clock.now(), kind)
    return { result: "blocked" }
  }

  private async refuse(applicationId: string, kind: "automatic" | "sample", refusal: ClaimRefusal, company: string | null): Promise<SubmitOutcome> {
    const now = this.clock.now()
    if (refusal === "same_company") {
      await this.repository.block(
        applicationId,
        null,
        { reason: "same_company_review", detail: `Held for your review: you have an active Application at ${company ?? "this company"}.` },
        now,
        kind
      )
      return { result: "blocked" }
    }
    if (refusal === "cap_reached" && kind === "automatic") {
      await this.repository.run((tx, candidateId) =>
        tx
          .updateTable("application")
          .set({ queued_for_local_day: nextWatDay(watDay(now)), updated_at: now })
          .where("candidate_id", "=", candidateId)
          .where("id", "=", applicationId)
          // TM-F-02: only while still queued, so a removal is never undone.
          .where("submission_state", "=", "queued")
          .execute()
      )
    }
    if (refusal === "duplicate" && kind === "sample") {
      await this.repository.run((tx, candidateId) =>
        tx.updateTable("application").set({ submission_state: "not_submitted", updated_at: now }).where("candidate_id", "=", candidateId).where("id", "=", applicationId).execute()
      )
    }
    await this.repository.logEvent(applicationId, `claim_refused_${refusal}`, null, now)
    return { result: "refused", refusal }
  }

  private async fillOne(session: FormSession, answer: FieldAnswer, files: Readonly<Record<"resume" | "cover_letter", StoredDocument | null>>): Promise<void> {
    if (answer.kind === "value") return session.fill(answer.ref, answer.value)
    const document = files[answer.document]
    if (document === null) throw new IncompleteError(null, INCOMPLETE_DETAIL.mismatch(null))
    return session.attach(answer.ref, document)
  }

  /** After every browser call before the click: still on the application host, and not paused. */
  private async checkpoint(session: FormSession, host: string): Promise<void> {
    const { form } = await session.readValues()
    if (form.host !== host) throw new IncompleteError("redirect", INCOMPLETE_DETAIL.redirect(form.host))
    await this.checkpointPause()
  }

  private async checkpointPause(): Promise<void> {
    const control = await this.repository.readControl()
    if (control.global_paused || control.cost_paused) throw new PausedError()
  }

  /**
   * Fill verification (submit fence part 1). Every required field has a value,
   * every non-empty field holds exactly the value backend code assigned, the
   * origin is unchanged, the guard caught nothing, and there is exactly one
   * submit control. Returns the verified page text, the "before" side of the
   * post-click evidence check (SEC-501).
   */
  private async verify(
    session: FormSession,
    host: string,
    answers: readonly FieldAnswer[],
    files: Readonly<Record<"resume" | "cover_letter", StoredDocument | null>>,
    work: Readonly<{ fields: readonly FormField[]; schema: readonly SchemaQuestion[] | null; sources: AnswerSources }>
  ): Promise<string> {
    const { form, values } = await session.readValues()
    if (form.host !== host) throw new IncompleteError("redirect", INCOMPLETE_DETAIL.redirect(form.host))
    if (form.guardTripped) throw new IncompleteError("submit_attempt", INCOMPLETE_DETAIL.submitAttempt)
    this.verifyWorkFields(form.controls, answers, work)
    const expected = new Map(answers.map((answer) => [answer.ref, answer.kind === "value" ? answer.value : files[answer.document]?.name ?? ""]))
    for (const control of form.controls) {
      const actual = values[control.ref] ?? ""
      const want = expected.get(control.ref)
      if (want === undefined ? actual !== "" : actual !== want) throw new IncompleteError("value_mismatch", INCOMPLETE_DETAIL.mismatch(control.label || null))
      if (control.required && actual === "") throw new IncompleteError("value_mismatch", INCOMPLETE_DETAIL.mismatch(control.label || null))
    }
    if (detectPageBlock(form.text)) throw new IncompleteError(null, INCOMPLETE_DETAIL.noSubmitControl)
    if (form.submitControls !== 1) throw new IncompleteError(null, INCOMPLETE_DETAIL.noSubmitControl)
    return form.text
  }

  /**
   * SEC-514: every answered work-authorization or sponsorship field must still
   * have the name and id it had when it was answered, and the fresh read must
   * still give the same answer. Otherwise nothing is clicked.
   */
  private verifyWorkFields(
    fresh: readonly FormField[],
    answers: readonly FieldAnswer[],
    work: Readonly<{ fields: readonly FormField[]; schema: readonly SchemaQuestion[] | null; sources: AnswerSources }>
  ): void {
    const reread = attachSchema(fresh, work.schema)
    for (const before of work.fields) {
      const now = reread.find((control) => control.ref === before.ref)
      const changed = (reason: string | null) => new IncompleteError("value_mismatch", INCOMPLETE_DETAIL.fieldChanged(reason))
      if (!now || (now.fieldName ?? "") !== (before.fieldName ?? "") || (now.fieldId ?? "") !== (before.fieldId ?? "")) throw changed(before.schemaQuestion?.text ?? null)
      const want = answers.find((answer) => answer.ref === before.ref)
      const outcome = answerFor(now, work.sources)
      if (!want || want.kind !== "value" || typeof outcome !== "object" || !("kind" in outcome) || outcome.kind !== "value" || outcome.value !== want.value) throw changed(before.schemaQuestion?.text ?? null)
    }
  }

  /** F-SEC-03: handles that read through CandidateFiles, not paths a session could copy. */
  private async storedDocuments(applicationId: string): Promise<Record<"resume" | "cover_letter", StoredDocument | null>> {
    const rows = await this.repository.findDocuments(applicationId)
    const document = (kind: "resume" | "cover_letter") => {
      const name = rows.find((row) => row.kind === kind)?.pdf_storage_name
      return name ? storedDocument(this.files, CandidateScope.require(), name) : null
    }
    return { resume: document("resume"), cover_letter: document("cover_letter") }
  }

  private answerSources(applicationId: string): Promise<AnswerSources> {
    return this.repository.loadAnswerSources(applicationId)
  }
}

export type { FormRead }
