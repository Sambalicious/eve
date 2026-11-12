import { Inject, Injectable, Logger } from "@nestjs/common"

import { CLOCK, type Clock } from "../shared/clock.js"
import { overrideReasonShort, storedDecision } from "../documents/override.js"
import type { StoredRule } from "../db/schema.js"
import { SpendLedger } from "../spend/spend-ledger.js"
import { StackPostsSummaryReader } from "../stack-posts/stack-posts-summary.js"
import { type DailySummaryInput, type RenderedEmail, renderAccessRequest, renderAccessRequestCap, renderBlocked, renderConfirmed, renderCostPause, renderDailySummary } from "./email-content.js"
import { MAILER, type Mailer, MailerError } from "./mailer.js"
import type { MailerConfig } from "./mailer-config.js"
import { AccessRequestOutboxRepository } from "./access-request-outbox.repository.js"
import { type ClaimedNotification, NotificationRepository } from "./notification.repository.js"
import { ruleInlineLabel } from "./rule-labels.js"

export const MAILER_CONFIG = Symbol("MAILER_CONFIG")

/** Attempts per row before it is `failed`. Delays between them: 1, 5, 15, 60 minutes. */
export const MAX_ATTEMPTS = 5
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000] as const
/**
 * SEC-601: one row is claimed at a time, so a crash mid-run can fail at most the
 * row being sent (marked `interrupted`), never rows that were not yet tried.
 */
const BATCH = 1

export type SendRunResult = Readonly<{ sent: number; retrying: number; failed: number; skipped: "not_configured" | null }>

export const SKIP_LABEL: Readonly<Record<string, (detail: string | null) => string>> = {
  unsupported_application_system: () => "Eve can't apply through this employer's application system",
  // D44: the rule in the dashboard's inline words ("doesn't fit your employment type rule").
  violated_rule: (detail) => (detail === null ? "doesn't fit one of your rules" : `doesn't fit your ${ruleInlineLabel(detail)} rule`),
  uncovered_mandatory_prerequisite: () => "your profile doesn't show a required prerequisite",
  weak_core_match: () => "your profile backs too few of the core responsibilities",
  no_core_responsibilities: () => "no core responsibilities found",
  // EPIC-0004 AC 5.9 and copy deck C-JC-SKIP-TECH: the dashboard line, verbatim.
  technology_mismatch: () => "doesn't mention your frameworks or technologies",
}

/** Copy deck C-AA-35: a queued override dropped at a check. */
const OVERRIDE_DROPPED = "the posting changed after you chose to prepare it anyway"

/** v1.24.0 drop table, "Daily summary Not a match reason": `closed` and no-override drops stay "posting closed" (C-SKIP-7). */
export function droppedReason(detail: string | null, override: boolean): string {
  if (detail === "override_mismatch") return OVERRIDE_DROPPED
  if (detail === "hidden" && override) return OVERRIDE_DROPPED
  return "posting closed"
}

const FAILURE_LABEL = { documents_blocked: "document validation blocked", documents_failed: "documents not generated" } as const

/**
 * The outbox sender (architecture r1). Each due row is claimed, rendered, sent
 * through the Mailer port and marked sent; a failure is retried with backoff
 * up to MAX_ATTEMPTS, then the row is `failed`. It writes nothing but
 * `notification_outbox`: it never resubmits, re-queues or changes an
 * Application (AC 6.15, 7.7). With no Gmail settings it does nothing and rows
 * stay pending.
 */
@Injectable()
export class NotificationSender {
  private readonly logger = new Logger(NotificationSender.name)

  constructor(
    private readonly repository: NotificationRepository,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(MAILER_CONFIG) private readonly config: MailerConfig | null,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: SpendLedger,
    private readonly stackPosts: StackPostsSummaryReader,
    private readonly installation: AccessRequestOutboxRepository
  ) {}

  get configured(): boolean {
    return this.config !== null
  }

  async sendDue(): Promise<SendRunResult> {
    if (!this.config) return { sent: 0, retrying: 0, failed: 0, skipped: "not_configured" }
    const totals = { sent: 0, retrying: 0, failed: 0 }
    // The scope's Candidate's rows, then (C36) the installation's access-request rows, each claimed in its own scope.
    for (const claim of [(now: Date) => this.repository.claimDue(now, BATCH), (now: Date) => this.installation.claimDue(now, BATCH)]) {
      for (;;) {
        const batch = await claim(this.clock.now())
        if (batch.length === 0) break
        for (const row of batch) totals[await this.sendOne(row, this.config.dashboardOrigin)] += 1
        if (batch.length < BATCH) break
      }
    }
    return { ...totals, skipped: null }
  }

  private async sendOne(row: ClaimedNotification, base: string): Promise<"sent" | "retrying" | "failed"> {
    try {
      const email = await this.render(row, base)
      if (email) await this.mailer.send(email)
      await this.outboxFor(row).markSent(row.id, this.clock.now())
      // AC 10.2 "email" category: tracked, never refused, so the cost-pause email itself goes out.
      if (email) await this.ledger.recordEmail().catch(() => undefined)
      return "sent"
    } catch (error) {
      const code = error instanceof MailerError ? error.code : "unknown"
      const now = this.clock.now()
      const last = row.attempts >= MAX_ATTEMPTS
      const delay = RETRY_DELAYS_MS[Math.min(row.attempts, RETRY_DELAYS_MS.length) - 1]!
      await this.outboxFor(row).markAttemptFailed(row.id, code, now, last ? null : new Date(now.getTime() + delay))
      // Kind, row id and code only: never the server's reply, the address or the password.
      this.logger.warn(`Notification ${row.kind} ${row.id} not sent (${code}), attempt ${row.attempts} of ${MAX_ATTEMPTS}${last ? ", giving up" : ""}`)
      return last ? "failed" : "retrying"
    }
  }

  /** C36: access-request rows are installation data, written only in the installation scope. */
  private outboxFor(row: ClaimedNotification): Pick<NotificationRepository, "markSent" | "markAttemptFailed"> {
    return row.kind === "access_request" || row.kind === "access_request_cap" ? this.installation : this.repository
  }

  /** Null: nothing to send any more (the Application was deleted), so the row is closed as sent. */
  private async render(row: ClaimedNotification, base: string): Promise<RenderedEmail | null> {
    if (row.kind === "daily_summary") return renderDailySummary({ ...(await this.summaryInput(row.watDay!)), stackPosts: await this.stackPosts.summary(row.id, row.claimedAt) }, base)
    if (row.kind === "access_request") {
      const window = row.accessRequestWindowId === null ? null : await this.installation.accessRequestWindow(row.accessRequestWindowId)
      return window ? renderAccessRequest(window) : null
    }
    if (row.kind === "access_request_cap") return renderAccessRequestCap({ day: row.watDay!, accepted: await this.installation.acceptedOn(row.watDay!) })
    if (row.kind === "cost_pause") {
      if (!row.payload) return null
      return renderCostPause({ ...row.payload, pausedAt: new Date(row.payload.pausedAt), globalPaused: await this.repository.globalPaused() }, base)
    }
    if (row.applicationId === null) return null
    const facts = await this.repository.emailFacts(row.applicationId)
    if (!facts) return null
    const identity = { applicationId: facts.id, role: facts.role_title ?? facts.title ?? "Role", company: facts.company ?? "Company", requisitionId: facts.requisition_id }
    // v1.24.0 (AA-4.6): only a stored decision gets the C-AA-32 line; a legacy override gets none (C-AA-33 reserved).
    const decision = facts.details_deleted_at === null ? storedDecision(facts) : null
    const reason = decision === null ? null : overrideReasonShort(decision)
    const override = reason === null || !(await this.repository.advancedEnabled()) ? null : { reason }
    if (row.kind === "blocked") {
      if (!facts.blocked_reason) return null
      return renderBlocked({ ...identity, reason: facts.blocked_reason, subReason: facts.blocked_sub_reason, detail: facts.blocked_detail, override }, base)
    }
    if (!facts.evidence_kind) return null
    const submittedAt = facts.submit_clicked_at ?? facts.confirmed_at ?? this.clock.now()
    return renderConfirmed(
      {
        ...identity,
        submittedAt,
        evidence: { kind: facts.evidence_kind, text: facts.evidence_text },
        sentAs: facts.submission_kind === "sample" ? "sample" : "automatic",
        employmentType: facts.employment_type,
        unverified: unverifiedRules(facts.rules),
        coverLetterStatus: facts.cover_letter_status,
        automaticToday: facts.submitted_local_day ? await this.repository.automaticCount(facts.submitted_local_day) : 0,
        override,
      },
      base
    )
  }

  private async summaryInput(day: string): Promise<DailySummaryInput> {
    const facts = await this.repository.dailySummaryFacts(day)
    const advanced = await this.repository.advancedEnabled()
    const name = (role: string | null, company: string | null) => ({ role: role ?? "Role", company: company ?? "Company" })
    return {
      watDay: day,
      automaticToday: facts.automaticToday,
      submitted: facts.submitted.map((row) => ({ ...name(row.role, row.company), requisitionId: row.requisition_id, override: advanced && row.override })),
      blockedCount: facts.counts.blocked,
      uncertainCount: facts.counts.uncertain,
      uncertain: facts.uncertain.map((row) => ({ ...name(row.role, row.company), submittedAt: row.submit_clicked_at ?? row.updated_at, captchaAfterSubmit: row.captcha_after_submit, override: advanced && row.override })),
      failures: facts.failures.map((row) => ({ ...name(row.role, row.company), reason: FAILURE_LABEL[row.state as keyof typeof FAILURE_LABEL], override: advanced && row.override })),
      skipped: [
        // `not_software_role` has no catalogue label and is not listed (OPEN[designer]).
        ...facts.skipped
          .filter((row) => row.skip_reason !== null && row.skip_reason in SKIP_LABEL)
          .map((row) => ({ ...name(row.title, row.company), reason: SKIP_LABEL[row.skip_reason!]!(row.skip_detail), manualPossible: row.skip_reason === "unsupported_application_system", override: advanced && row.override })),
        ...facts.dropped.map((row) => ({ ...name(row.role, row.company), reason: droppedReason(row.detail, row.override), manualPossible: false, override: advanced && row.override })),
      ],
      globalPaused: facts.control.global_paused,
      costPaused: facts.control.cost_paused,
      costResumedToday: facts.costResumedToday,
      spend: await this.monthSpend(),
      retentionDeleted: facts.retentionDeleted,
    }
  }

  /** E3 "Spend": this month's spend against this month's ceiling (CR6-05). */
  private async monthSpend(): Promise<DailySummaryInput["spend"]> {
    const month = await this.ledger.month()
    return { spentMicros: month.spent, ceilingMicros: month.ceiling }
  }
}

/** E1 "Unverified": Eligibility rules the posting didn't state. */
function unverifiedRules(rules: readonly StoredRule[] | null): string[] {
  return (rules ?? []).filter((rule) => rule.result === "unverified").map((rule) => rule.rule)
}

