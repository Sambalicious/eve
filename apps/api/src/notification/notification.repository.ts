import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import type { CostPausePayload, NotificationError, NotificationKind } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { nextWatDay } from "../submission/wat-day.js"
import { visibilityContext, visibleSql } from "../discovery/visibility.js"

export type ClaimedNotification = Readonly<{
  id: string
  kind: Exclude<NotificationKind, "uncertain">
  applicationId: string | null
  watDay: string | null
  attempts: number
  /** Set for `cost_pause` (E4 facts captured when the pause started). */
  payload: CostPausePayload | null
  /** Set for `access_request`: the window's first request id (EPIC-0003). */
  accessRequestWindowId: string | null
  /** EPIC-0005 D-E5-3: this attempt's claim time bounds the daily summary's "new" Stack posts. */
  claimedAt: Date
}>

/**
 * Every Candidate kind the sender emails. `uncertain` rows feed the daily summary and are never sent
 * alone. EPIC-0003's `access_request` and `access_request_cap` are installation rows (C36), claimed by
 * `AccessRequestOutboxRepository`.
 */
const CANDIDATE_SENDABLE_KINDS = ["confirmed", "blocked", "daily_summary", "cost_pause"] as const satisfies readonly NotificationKind[]

const LIST_LIMIT = 200

/** UTC bounds of a WAT day (Africa/Lagos is UTC+1 all year). */
function watDayBounds(day: string): readonly [Date, Date] {
  return [new Date(`${day}T00:00:00+01:00`), new Date(`${nextWatDay(day)}T00:00:00+01:00`)]
}

/**
 * The sender's reads and writes. It writes only `notification_outbox`; it
 * reads Applications and postings to fill emails and never updates them
 * (AC 6.15, 7.7: a failed send never resubmits or changes an Application).
 *
 * EPIC-0002 A1: the scope's Candidate's rows only; every statement runs in its
 * `CandidateTx` and names its `candidate_id`. The worker runs the sender in the
 * Operator's scope (Operator rows only until slice F). `control_state` and
 * `job_posting` (titles) are shared tables read in the same transaction; the
 * skipped list reads the Candidate's `candidate_posting` rows.
 */
@Injectable()
export class NotificationRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** Claims due rows (skip-locked, so two senders never take the same row) and counts the attempt. */
  async claimDue(now: Date, limit: number): Promise<ClaimedNotification[]> {
    return this.tenant.run(async (trx, candidateId) => {
      const due = await trx
        .selectFrom("notification_outbox")
        .select("id")
        .where("candidate_id", "=", candidateId)
        .where("status", "=", "pending")
        .where("kind", "in", CANDIDATE_SENDABLE_KINDS)
        .where((eb) => eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", now)]))
        .orderBy("created_at")
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute()
      if (due.length === 0) return []
      const rows = await trx
        .updateTable("notification_outbox")
        .set((eb) => ({ status: "sending", claimed_at: now, attempts: eb("attempts", "+", 1) }))
        .where("candidate_id", "=", candidateId)
        .where("id", "in", due.map((row) => row.id))
        .returning(["id", "kind", "application_id", sql<string | null>`local_day::text`.as("local_day"), "attempts", "payload", "access_request_window_id", "claimed_at"])
        .execute()
      return rows
        .map((row) => ({
          id: row.id,
          kind: row.kind as ClaimedNotification["kind"],
          applicationId: row.application_id,
          watDay: row.local_day,
          attempts: row.attempts,
          payload: row.payload,
          accessRequestWindowId: row.access_request_window_id,
          claimedAt: row.claimed_at ?? now,
        }))
        .sort((a, b) => due.findIndex((d) => d.id === a.id) - due.findIndex((d) => d.id === b.id))
    })
  }

  /** E4 `{Global pause line}` is read at send time. */
  async globalPaused(): Promise<boolean> {
    const control = await this.tenant.run((tx) => tx.selectFrom("control_state").select("global_paused").executeTakeFirstOrThrow())
    return control.global_paused
  }

  async markSent(id: string, at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx.updateTable("notification_outbox").set({ status: "sent", sent_at: at, next_attempt_at: null }).where("candidate_id", "=", candidateId).where("id", "=", id).where("status", "=", "sending").execute()
    )
  }

  /** `retryAt: null` is the last attempt: the row is `failed` and feeds `C-NOTIFY-1`. */
  async markAttemptFailed(id: string, code: NotificationError, at: Date, retryAt: Date | null): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("notification_outbox")
        .set(retryAt ? { status: "pending", last_error: code, next_attempt_at: retryAt } : { status: "failed", last_error: code, last_failed_at: at, next_attempt_at: null })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .where("status", "=", "sending")
        .execute()
    )
  }

  /** Worker start: the scope's Candidate's rows left `sending` may or may not have gone out, so they are failed, never resent. */
  async failInterrupted(at: Date): Promise<number> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("notification_outbox")
        .set({ status: "failed", last_error: "interrupted", last_failed_at: at, next_attempt_at: null })
        .where("candidate_id", "=", candidateId)
        .where("status", "=", "sending")
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows)
  }

  /** AC 7.3: one summary row per Candidate and WAT day; a second run for the same day changes nothing. */
  async enqueueDailySummary(day: string, at: Date): Promise<boolean> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
      .insertInto("notification_outbox")
      .values({ id: randomUUID(), candidate_id: candidateId, application_id: null, kind: "daily_summary", local_day: day, created_at: at, sent_at: null })
      .onConflict((oc) => oc.columns(["candidate_id", "local_day"]).where("kind", "=", "daily_summary").doNothing())
      .returning("id")
      .executeTakeFirst()
    )
    return result !== undefined
  }

  /** `C-NOTIFY-1`: the latest final failure, unless a later email was sent. */
  /** The latest final failure among `kinds`, unless a later email (of any kind) sent. */
  async latestFailure(kinds: readonly NotificationKind[]) {
    return this.tenant.run(async (tx, candidateId) => {
      const failed = await tx
        .selectFrom("notification_outbox")
        .select(["kind", "application_id", sql<string | null>`local_day::text`.as("local_day"), "last_failed_at"])
        .where("candidate_id", "=", candidateId)
        .where("kind", "in", kinds)
        .where("status", "=", "failed")
        .where("last_failed_at", "is not", null)
        .orderBy("last_failed_at", "desc")
        .limit(1)
        .executeTakeFirst()
      if (!failed?.last_failed_at) return null
      const laterSend = await tx
        .selectFrom("notification_outbox")
        .select("id")
        .where("candidate_id", "=", candidateId)
        .where("status", "=", "sent")
        .where("sent_at", ">", failed.last_failed_at)
        .limit(1)
        .executeTakeFirst()
      return laterSend ? null : { ...failed, last_failed_at: failed.last_failed_at }
    })
  }

  /** Rows still waiting or going out (C-NOTIFY-1 pending count). The scope's Candidate's rows only. */
  async pendingCount(): Promise<number> {
    const row = await this.tenant.run((tx, candidateId) =>
      tx.selectFrom("notification_outbox").select((eb) => eb.fn.countAll<string>().as("count")).where("candidate_id", "=", candidateId).where("status", "in", ["pending", "sending"]).executeTakeFirstOrThrow()
    )
    return Number(row.count)
  }

  /** Whether the scope's Candidate is the Operator (identity table, never the request). The access-request alert is Operator-only (C36). */
  async isOperator(): Promise<boolean> {
    const row = await this.tenant.run((tx, candidateId) => tx.selectFrom("candidate").select("role").where("id", "=", candidateId).executeTakeFirst())
    return row?.role === "operator"
  }

  /** The scope's Candidate's Advanced switch. With Advanced off, emails leave out the Override wording and marker. */
  async advancedEnabled(): Promise<boolean> {
    const row = await this.tenant.run((tx, candidateId) => tx.selectFrom("candidate_view_setting").select("advanced_enabled").where("candidate_id", "=", candidateId).executeTakeFirst())
    return row?.advanced_enabled ?? false
  }

  /** The shared sender singleton: is Gmail configured on the worker? */
  async senderConfigured(): Promise<boolean> {
    const row = await this.tenant.run((tx) => tx.selectFrom("notification_sender_state").select("configured").executeTakeFirst())
    return row?.configured ?? false
  }

  /** Worker start writes the shared sender singleton; no Candidate data, so a shared transaction. */
  async recordSenderState(configured: boolean, at: Date): Promise<void> {
    await this.tenant.forShared((tx) =>
      tx
        .insertInto("notification_sender_state")
        .values({ singleton: true, configured, updated_at: at })
        .onConflict((oc) => oc.column("singleton").doUpdateSet({ configured, updated_at: at }))
        .execute()
    )
  }

  /** E1 and E2 facts. Approved Answer values, document content and salary figures are never selected. */
  emailFacts(applicationId: string) {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
        .leftJoin("eligibility_result", (join) => join.onRef("eligibility_result.job_posting_id", "=", "job_posting.id").on("eligibility_result.candidate_id", "=", candidateId))
        .select([
          "application.id",
          "application.role_title",
          "job_posting.title",
          "application.company",
          "application.requisition_id",
          "application.submission_kind",
          sql<string | null>`application.submitted_local_day::text`.as("submitted_local_day"),
          "application.submit_clicked_at",
          "application.confirmed_at",
          "application.evidence_kind",
          "application.evidence_text",
          "application.cover_letter_status",
          "application.blocked_reason",
          "application.blocked_sub_reason",
          "application.blocked_detail",
          "eligibility_result.employment_type",
          "eligibility_result.rules",
          // v1.24.0 (AA-4.6): the stored override decision for the C-AA-32 line.
          "application.candidate_override_at",
          "application.override_created_at",
          "application.override_status",
          "application.override_skip_reason",
          "application.override_skip_detail",
          "application.override_violated_rules",
          "application.details_deleted_at",
        ])
        .where("application.candidate_id", "=", candidateId)
        .where("application.id", "=", applicationId)
        .executeTakeFirst()
    )
  }

  /**
   * F-QA6-01: the "{n} of 5" both E1 and E3 show. Only Confirmed automatic
   * Submissions for the WAT day; in-flight and unresolved Uncertain ones don't
   * count (prd.r4 AC 6.1), so the number never changes after the email is read.
   */
  async automaticCount(day: string): Promise<number> {
    return this.tenant.run((tx, candidateId) => automaticCount(tx, candidateId, day))
  }

  /** E3 inputs for one WAT day, each list bounded; one transaction, statements in turn. */
  dailySummaryFacts(day: string) {
    return this.tenant.run((tx, candidateId) => dailySummaryFacts(tx, candidateId, day))
  }
}

async function automaticCount(tx: CandidateTx, candidateId: string, day: string): Promise<number> {
  const row = await tx
    .selectFrom("application")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("candidate_id", "=", candidateId)
    .where("submission_kind", "=", "automatic")
    .where(sql<boolean>`submitted_local_day = ${day}::date`)
    .where("submission_state", "=", "confirmed")
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

/** Skipped postings are the Candidate's own `candidate_posting` rows, with title and company from the shared posting (item 6). */
async function dailySummaryFacts(tx: CandidateTx, candidateId: string, day: string) {
  const [start, end] = watDayBounds(day)
  const role = sql<string | null>`coalesce(application.role_title, job_posting.title)`
  // v1.24.0 (AA-4.6): an override recorded on the Application, legacy included (cleared on deletion).
  const override = sql<boolean>`(application.override_created_at is not null or application.candidate_override_at is not null)`
  const submitted = await tx
    .selectFrom("application")
    .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
    .select([role.as("role"), "application.company", "application.requisition_id", override.as("override")])
    .where("application.candidate_id", "=", candidateId)
    .where("application.submission_state", "=", "confirmed")
    .where(sql<boolean>`application.submitted_local_day = ${day}::date`)
    .orderBy("application.submit_clicked_at")
    .limit(LIST_LIMIT)
    .execute()
  const uncertain = await tx
    .selectFrom("application")
    .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
    .select([role.as("role"), "application.company", "application.submit_clicked_at", "application.updated_at", "application.captcha_after_submit", override.as("override")])
    .where("application.candidate_id", "=", candidateId)
    .where("application.submission_state", "=", "uncertain")
    .where(sql<boolean>`application.submitted_local_day = ${day}::date`)
    .orderBy("application.submit_clicked_at")
    .limit(LIST_LIMIT)
    .execute()
  // EPIC-0006 (AC-3.10, api-contract.r1 "Other"): the skipped and failure lists hold only postings visible for this
  // Candidate at the end of the summary's WAT day; no new line.
  const ctx = await visibilityContext(tx, candidateId, new Date(end.getTime() - 1))
  const failures = await tx
    .selectFrom("application")
    .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
    .select([role.as("role"), "application.company", "application.state", override.as("override")])
    .where("application.candidate_id", "=", candidateId)
    .where("application.state", "in", ["documents_blocked", "documents_failed"])
    .where(visibleSql("job_posting", ctx))
    .where("application.updated_at", ">=", start)
    .where("application.updated_at", "<", end)
    .orderBy("application.updated_at")
    .limit(LIST_LIMIT)
    .execute()
  const decidedAt = sql`coalesce(cp.evaluated_at, cp.discovered_at)`
  const skipped = await tx
    .selectFrom("candidate_posting as cp")
    .innerJoin("job_posting as p", "p.id", "cp.job_posting_id")
    .select(["p.title", "p.company", "cp.skip_reason", "cp.skip_detail"])
    // v1.24.0 (AA-4.6): the marker when the requisition has an Application with an override recorded.
    .select(
      sql<boolean>`exists (select 1 from application a where a.candidate_id = ${candidateId}::uuid and a.application_url = p.application_url and a.requisition_id = p.requisition_id
        and (a.override_created_at is not null or a.candidate_override_at is not null))`.as("override")
    )
    .where("cp.candidate_id", "=", candidateId)
    .where("cp.status", "in", ["skipped", "excluded"])
    .where(visibleSql("p", ctx))
    .where(sql<boolean>`${decidedAt} >= ${start} and ${decidedAt} < ${end}`)
    .orderBy(decidedAt)
    .limit(LIST_LIMIT)
    .execute()
  const dropped = await tx
    .selectFrom("submission_event")
    .innerJoin("application", "application.id", "submission_event.application_id")
    .innerJoin("job_posting", "job_posting.id", "application.job_posting_id")
    .select([role.as("role"), "application.company", "submission_event.detail", override.as("override")])
    .where("submission_event.candidate_id", "=", candidateId)
    .where("application.candidate_id", "=", candidateId)
    // EPIC-0002 B1: both drop kinds are the Operator's Dropped list (a rules drop is still a drop).
    .where("submission_event.kind", "in", ["queued_posting_dropped", "queued_posting_preferences_changed"])
    .where("submission_event.created_at", ">=", start)
    .where("submission_event.created_at", "<", end)
    .orderBy("submission_event.created_at")
    .limit(LIST_LIMIT)
    .execute()
  const counts = await tx
    .selectFrom("application")
    .select((eb) => [
        eb.fn.countAll<string>().filterWhere("submission_state", "=", "blocked").as("blocked"),
        eb.fn.countAll<string>().filterWhere("submission_state", "=", "uncertain").as("uncertain"),
      ])
    .where("candidate_id", "=", candidateId)
    .executeTakeFirstOrThrow()
  const control = await tx.selectFrom("control_state").select(["global_paused", "cost_paused", "cost_pause_cleared_at"]).executeTakeFirstOrThrow()
  const automaticToday = await automaticCount(tx, candidateId, day)
  // Automatic expiry (E5.4, D-E7): what that WAT day's runs deleted. Counts only.
  const retention = await tx
    .selectFrom("retention_run")
    .select(sql<string>`coalesce(sum(deleted_count), 0)::text`.as("deleted"))
    .where("candidate_id", "=", candidateId)
    .where(sql<boolean>`wat_date = ${day}::date`)
    .executeTakeFirstOrThrow()
  const clearedAt = control.cost_pause_cleared_at
  const costResumedToday = !control.cost_paused && clearedAt !== null && clearedAt >= start && clearedAt < end
  return { submitted, uncertain, failures, skipped, dropped, counts: { blocked: Number(counts.blocked), uncertain: Number(counts.uncertain) }, control, costResumedToday, automaticToday, retentionDeleted: Number(retention.deleted) }
}
