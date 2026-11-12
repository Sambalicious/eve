import { Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import type { AccessRequestStatus, NotificationError } from "../db/schema.js"
import { INSTALLATION_OUTBOX_KINDS } from "../db/migrations/0017-row-level-security.js"
import { type InstallationTx, TenantDatabase } from "../db/tenant-database.js"
import type { ClaimedNotification } from "./notification.repository.js"

/** `access_request` is paid-work-like and waits during a cost or global pause (EPIC-0003 AC 11.25); `access_request_cap` always sends. */
const PAUSE_HELD_KINDS: readonly string[] = ["access_request"]

/**
 * The sender's installation branch (C36, architecture r4 Tenancy 2a): EPIC-0003's
 * `access_request` and `access_request_cap` outbox rows and the requests they
 * mail. Every statement runs in `forInstallation`, so no Candidate row is
 * visible here and these rows are visible nowhere else. Until slice F's claim
 * function, the sender walks Candidate rows (Operator scope) and these in turn.
 */
@Injectable()
export class AccessRequestOutboxRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** Claims due installation rows (skip-locked) and counts the attempt. */
  claimDue(now: Date, limit: number): Promise<ClaimedNotification[]> {
    return this.tenant.forInstallation(async (trx) => {
      const control = await trx.selectFrom("control_state").select(["global_paused", "cost_paused"]).executeTakeFirst()
      const paused = control !== undefined && (control.global_paused || control.cost_paused)
      const kinds = INSTALLATION_OUTBOX_KINDS.filter((kind) => !(paused && PAUSE_HELD_KINDS.includes(kind)))
      const due = await trx
        .selectFrom("notification_outbox")
        .select("id")
        .where("candidate_id", "is", null)
        .where("status", "=", "pending")
        .where("kind", "in", kinds)
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
        .where("candidate_id", "is", null)
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

  async markSent(id: string, at: Date): Promise<void> {
    await this.tenant.forInstallation(async (trx) => {
      const row = await trx
        .updateTable("notification_outbox")
        .set({ status: "sent", sent_at: at, next_attempt_at: null })
        .where("candidate_id", "is", null)
        .where("id", "=", id)
        .where("status", "=", "sending")
        .returning("access_request_window_id")
        .executeTakeFirst()
      await mirrorWindowStatus(trx, row?.access_request_window_id ?? null, "sent")
    })
  }

  /** `retryAt: null` is the last attempt: the row and its window's requests are `failed`. */
  async markAttemptFailed(id: string, code: NotificationError, at: Date, retryAt: Date | null): Promise<void> {
    await this.tenant.forInstallation(async (trx) => {
      const row = await trx
        .updateTable("notification_outbox")
        .set(retryAt ? { status: "pending", last_error: code, next_attempt_at: retryAt } : { status: "failed", last_error: code, last_failed_at: at, next_attempt_at: null })
        .where("candidate_id", "is", null)
        .where("id", "=", id)
        .where("status", "=", "sending")
        .returning("access_request_window_id")
        .executeTakeFirst()
      if (!retryAt) await mirrorWindowStatus(trx, row?.access_request_window_id ?? null, "failed")
    })
  }

  /** Worker start: installation rows left `sending` may or may not have gone out, so they are failed, never resent. */
  failInterrupted(at: Date): Promise<number> {
    return this.tenant.forInstallation(async (trx) => {
      const rows = await trx
        .updateTable("notification_outbox")
        .set({ status: "failed", last_error: "interrupted", last_failed_at: at, next_attempt_at: null })
        .where("candidate_id", "is", null)
        .where("status", "=", "sending")
        .returning("access_request_window_id")
        .execute()
      for (const row of rows) await mirrorWindowStatus(trx, row.access_request_window_id, "failed")
      return rows.length
    })
  }

  /**
   * EPIC-0003: the visitor email and every request in an access-request window,
   * oldest first. Null when retention already deleted them (the row then closes
   * as sent with nothing mailed).
   */
  async accessRequestWindow(windowId: string): Promise<{ email: string; requests: { note: string; createdAt: Date }[] } | null> {
    const rows = await this.tenant.forInstallation((trx) =>
      trx.selectFrom("access_request").select(["email", "note", "created_at"]).where("window_id", "=", windowId).orderBy("created_at").orderBy("id").execute()
    )
    const [first] = rows
    if (!first) return null
    return { email: first.email, requests: rows.map((row) => ({ note: row.note, createdAt: row.created_at })) }
  }

  /** EPIC-0003: accepted access requests on a UTC day, for the cap alert. */
  async acceptedOn(day: string): Promise<number> {
    const start = new Date(`${day}T00:00:00.000Z`)
    const end = new Date(start.getTime() + 24 * 3_600_000)
    const row = await this.tenant.forInstallation((trx) =>
      trx.selectFrom("access_request").select((eb) => eb.fn.countAll<string>().as("count")).where("created_at", ">=", start).where("created_at", "<", end).executeTakeFirstOrThrow()
    )
    return Number(row.count)
  }

  /** EPIC-0003 (7.11): counts for the Operator's Home alert. Counts only, never content. */
  async counts(): Promise<{ waiting: number; failed: number }> {
    const row = await this.tenant.forInstallation((trx) =>
      trx
        .selectFrom("notification_outbox")
        .select((eb) => [
          eb.fn.countAll<string>().filterWhere((w) => w.and([w("kind", "=", "access_request"), w("status", "in", ["pending", "sending"])])).as("waiting"),
          eb.fn.countAll<string>().filterWhere("status", "=", "failed").as("failed"),
        ])
        .where("candidate_id", "is", null)
        .executeTakeFirstOrThrow()
    )
    return { waiting: Number(row.waiting), failed: Number(row.failed) }
  }
}

/** Every request in a window takes its email's final status (AC 11.20 "delivery status"). */
async function mirrorWindowStatus(trx: InstallationTx, windowId: string | null, status: AccessRequestStatus): Promise<void> {
  if (windowId === null) return
  await trx.updateTable("access_request").set({ status }).where("window_id", "=", windowId).execute()
}
