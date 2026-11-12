import { randomUUID } from "node:crypto"

import { Inject, Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import type { CostPausePayload, SpendCategory } from "../db/schema.js"
import { type SharedTx, TenantDatabase } from "../db/tenant-database.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { SPEND_CONFIG } from "./spend-config.js"
import { type SpendConfig, watMonth, wouldCross } from "./spend-math.js"

/** E4 `{action label}`: what the refused paid action was. */
export type CostAction = "discovery run" | "document generation" | "Eligibility and Match check" | "form filling" | "Career Profile drafting"

export type ReserveRequest = Readonly<{
  category: SpendCategory
  purpose: string
  estimateMicros: number
  action: CostAction | null
  applicationId?: string | null
  attemptId?: string | null
  /** Form-agent spend: also checked against the per-attempt and monthly caps. */
  formAgent?: boolean
  /** AC 10.1: discovery, document generation and submission also stop for the global pause. */
  haltOnGlobalPause?: boolean
}>

export type ReserveRefusal = "paused" | "cost_paused" | "budget_exhausted"
export type Reservation = Readonly<{ ok: true; id: string }> | Readonly<{ ok: false; refusal: ReserveRefusal }>

type Trx = SharedTx

/**
 * The spend ledger (prd.r4.md AC 10.2, architecture r1 "Cost metering").
 * Every paid action reserves its estimated cost first, inside a transaction
 * that locks this month's `spend_month` row, so concurrent reservations
 * serialize and can never jointly cross the ceiling. A reservation that would
 * take the month above its ceiling is refused, paid automation pauses for
 * cost, and one cost-pause email is queued in the outbox. After the action the
 * reservation is settled with the actual cost (or released when nothing ran).
 *
 * The ceiling, the form-agent caps and the prices come only from code and the
 * server environment; no model output reaches them (AC 10.5).
 *
 * EPIC-0002 A1: one installation-wide ledger until slice D adds a Candidate
 * kind (architecture r2). `spend_month`, `spend_entry` and `control_state` are
 * shared, so every transaction is a `forShared` one with no Candidate setting.
 * The cost-pause email (E4) is the Operator's (Operator only until slice F), so
 * its outbox row names the Operator from the identity table, never the scope.
 */
@Injectable()
export class SpendLedger {
  constructor(
    private readonly tenant: TenantDatabase,
    @Inject(SPEND_CONFIG) private readonly config: SpendConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async reserve(request: ReserveRequest): Promise<Reservation> {
    const estimate = Math.max(0, Math.ceil(request.estimateMicros))
    return this.tenant.forShared(async (trx) => {
      const now = this.clock.now()
      const month = await this.lockMonth(trx, now)
      const control = await this.lockControl(trx, now, month.month)
      if (request.haltOnGlobalPause === true && control.global_paused) return refused("paused")
      if (control.cost_paused) return refused("cost_paused")
      const spent = await this.monthSpent(trx, month.month)
      if (wouldCross(spent, estimate, month.ceiling)) {
        await this.startCostPause(trx, { month: month.month, spent, ceiling: month.ceiling, action: request.action, estimate, at: now })
        return refused("cost_paused")
      }
      if (request.formAgent === true && !(await this.formAgentRoom(trx, month.month, request.attemptId ?? null, estimate))) return refused("budget_exhausted")
      const id = randomUUID()
      await trx
        .insertInto("spend_entry")
        .values({
          id,
          month: month.month,
          category: request.category,
          sub_budget: request.formAgent === true ? "form_agent" : null,
          purpose: request.purpose,
          status: "reserved",
          reserved_micros: estimate,
          actual_micros: null,
          application_id: request.applicationId ?? null,
          attempt_id: request.attemptId ?? null,
          created_at: now,
          settled_at: null,
        })
        .execute()
      return { ok: true as const, id }
    })
  }

  /**
   * Records the actual cost. A settled total above the ceiling (the provider
   * reported more than estimated) pauses paid automation at once, so the next
   * reservation is refused whatever the next estimate is.
   */
  async settle(id: string, actualMicros: number): Promise<void> {
    const actual = Math.max(0, Math.ceil(actualMicros))
    await this.tenant.forShared(async (trx) => {
      const now = this.clock.now()
      const entry = await trx.selectFrom("spend_entry").select([sql<string>`month::text`.as("month"), "status"]).where("id", "=", id).executeTakeFirst()
      if (!entry || entry.status !== "reserved") return
      const month = await this.lockMonthRow(trx, entry.month)
      await trx.updateTable("spend_entry").set({ status: "settled", actual_micros: actual, settled_at: now }).where("id", "=", id).execute()
      if (entry.month !== watMonth(now)) return
      const control = await this.lockControl(trx, now, entry.month)
      const spent = await this.monthSpent(trx, entry.month)
      if (!control.cost_paused && spent > month.ceiling) {
        await this.startCostPause(trx, { month: entry.month, spent, ceiling: month.ceiling, action: null, estimate: null, at: now })
      }
    })
  }

  /** One sent email (`SPEND_EMAIL_USD`, default 0: Gmail SMTP has no per-message price). */
  recordEmail(): Promise<void> {
    return this.record("email", "notification_email", this.config.emailMicros)
  }

  /**
   * Spend that is tracked but never refused: email (the cost-pause email itself
   * must go out during the pause). Settled at once.
   */
  async record(category: SpendCategory, purpose: string, micros: number): Promise<void> {
    if (micros <= 0) return
    await this.tenant.forShared(async (trx) => {
      const now = this.clock.now()
      const month = await this.lockMonth(trx, now)
      await trx
        .insertInto("spend_entry")
        .values({ id: randomUUID(), month: month.month, category, sub_budget: null, purpose, status: "settled", reserved_micros: micros, actual_micros: micros, application_id: null, attempt_id: null, created_at: now, settled_at: now })
        .execute()
    })
  }

  /** Nothing ran: the reservation no longer counts. */
  async release(id: string): Promise<void> {
    await this.tenant.forShared((tx) =>
      tx.updateTable("spend_entry").set({ status: "released", settled_at: this.clock.now() }).where("id", "=", id).where("status", "=", "reserved").execute()
    )
  }

  /**
   * 00:00 WAT on the 1st: a cost pause from an earlier month clears on its own
   * (r2 Candidate decision). The global pause is untouched. Called by the
   * worker every minute and before every read, so the state is never stale.
   */
  async rollover(): Promise<boolean> {
    const now = this.clock.now()
    const current = watMonth(now)
    const result = await this.tenant.forShared((tx) =>
      tx
        .updateTable("control_state")
        .set({ cost_paused: false, cost_pause_cleared_at: now })
        .where("cost_paused", "=", true)
        .where(sql<boolean>`(cost_paused_month is null or cost_paused_month < ${current}::date)`)
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows) > 0
  }

  /** This month's ceiling and spend, creating the month (and its hosting accrual) on first use. */
  async month(): Promise<{ month: string; ceiling: number; raisedAt: Date | null; spent: number; byCategory: Record<SpendCategory, number> }> {
    await this.rollover()
    return this.tenant.forShared(async (trx) => {
      const month = await this.lockMonth(trx, this.clock.now())
      const rows = await trx
        .selectFrom("spend_entry")
        .select(["category", sql<string>`coalesce(sum(case when status = 'settled' then actual_micros when status = 'reserved' then reserved_micros else 0 end), 0)`.as("micros")])
        .where("month", "=", month.month)
        .groupBy("category")
        .execute()
      const byCategory: Record<SpendCategory, number> = { hosting: 0, ai: 0, browser: 0, discovery: 0, email: 0 }
      for (const row of rows) byCategory[row.category] = Number(row.micros)
      const spent = Object.values(byCategory).reduce((sum, value) => sum + value, 0)
      return { month: month.month, ceiling: month.ceiling, raisedAt: month.raisedAt, spent, byCategory }
    })
  }

  /**
   * Raises this month's ceiling (validated by the caller). If the cost pause is
   * on for this month and the new ceiling leaves room for the refused action,
   * it clears. Returns whether the pause cleared.
   */
  async raiseCeiling(month: string, ceilingMicros: number): Promise<boolean> {
    return this.tenant.forShared(async (trx) => {
      const now = this.clock.now()
      await this.lockMonthRow(trx, month)
      await trx.updateTable("spend_month").set({ ceiling_micros: ceilingMicros, raised_at: now }).where("month", "=", month).execute()
      const control = await this.lockControl(trx, now, month)
      if (!control.cost_paused) return false
      const spent = await this.monthSpent(trx, month)
      const next = Number(control.cost_pause_estimate_micros ?? 0)
      if (wouldCross(spent, next, ceilingMicros) || spent >= ceilingMicros) return false
      await trx.updateTable("control_state").set({ cost_paused: false }).execute()
      return true
    })
  }

  private async lockMonth(trx: Trx, now: Date): Promise<{ month: string; ceiling: number; raisedAt: Date | null }> {
    const month = watMonth(now)
    const inserted = await trx
      .insertInto("spend_month")
      .values({ month, ceiling_micros: this.config.ceilingMicros, raised_at: null, created_at: now })
      .onConflict((oc) => oc.column("month").doNothing())
      .returning("month")
      .executeTakeFirst()
    if (inserted && this.config.hostingMonthlyMicros > 0) {
      // Hosting accrues once, on the month's first use (architecture r1).
      await trx
        .insertInto("spend_entry")
        .values({ id: randomUUID(), month, category: "hosting", sub_budget: null, purpose: "hosting", status: "settled", reserved_micros: this.config.hostingMonthlyMicros, actual_micros: this.config.hostingMonthlyMicros, application_id: null, attempt_id: null, created_at: now, settled_at: now })
        .onConflict((oc) => oc.column("month").where("category", "=", "hosting").doNothing())
        .execute()
    }
    return this.lockMonthRow(trx, month)
  }

  private async lockMonthRow(trx: Trx, month: string): Promise<{ month: string; ceiling: number; raisedAt: Date | null }> {
    const row = await trx
      .selectFrom("spend_month")
      .select([sql<string>`month::text`.as("month"), "ceiling_micros", "raised_at"])
      .where("month", "=", month)
      .forUpdate()
      .executeTakeFirstOrThrow()
    return { month: row.month, ceiling: Number(row.ceiling_micros), raisedAt: row.raised_at }
  }

  /** Locks the control row; a cost pause from an earlier month is cleared first. */
  private async lockControl(trx: Trx, now: Date, month: string) {
    const control = await trx.selectFrom("control_state").selectAll().select(sql<string | null>`cost_paused_month::text`.as("cost_paused_month")).forUpdate().executeTakeFirstOrThrow()
    if (control.cost_paused && (control.cost_paused_month === null || control.cost_paused_month < month)) {
      await trx.updateTable("control_state").set({ cost_paused: false, cost_pause_cleared_at: now }).execute()
      return { ...control, cost_paused: false }
    }
    return control
  }

  private async monthSpent(trx: Trx, month: string): Promise<number> {
    const row = await trx
      .selectFrom("spend_entry")
      .select(sql<string>`coalesce(sum(case when status = 'settled' then actual_micros when status = 'reserved' then reserved_micros else 0 end), 0)`.as("micros"))
      .where("month", "=", month)
      .executeTakeFirstOrThrow()
    return Number(row.micros)
  }

  private async formAgentRoom(trx: Trx, month: string, attemptId: string | null, estimate: number): Promise<boolean> {
    const used = (rows: { micros: string }) => Number(rows.micros)
    const counted = sql<string>`coalesce(sum(case when status = 'settled' then actual_micros when status = 'reserved' then reserved_micros else 0 end), 0)`
    const monthly = await trx.selectFrom("spend_entry").select(counted.as("micros")).where("month", "=", month).where("sub_budget", "=", "form_agent").executeTakeFirstOrThrow()
    if (used(monthly) + estimate > this.config.formAgent.monthlyMicros) return false
    // No attempt ID means no attempt to bound: refuse rather than run uncapped.
    if (attemptId === null) return false
    const attempt = await trx.selectFrom("spend_entry").select(counted.as("micros")).where("attempt_id", "=", attemptId).where("sub_budget", "=", "form_agent").executeTakeFirstOrThrow()
    return used(attempt) + estimate <= this.config.formAgent.perAttemptMicros
  }

  /** Sets the cost pause and queues its one email (E4) in the same transaction. */
  private async startCostPause(
    trx: Trx,
    facts: Readonly<{ month: string; spent: number; ceiling: number; action: CostAction | null; estimate: number | null; at: Date }>
  ): Promise<void> {
    await trx
      .updateTable("control_state")
      .set({ cost_paused: true, cost_paused_at: facts.at, cost_paused_month: facts.month, cost_pause_action: facts.action, cost_pause_estimate_micros: facts.estimate })
      .execute()
    const payload: CostPausePayload = {
      month: facts.month,
      spentMicros: facts.spent,
      ceilingMicros: facts.ceiling,
      action: facts.action,
      estimateMicros: facts.estimate,
      pausedAt: facts.at.toISOString(),
    }
    // The email is the Operator's row (RLS): written in the Operator's scope, in this same transaction.
    await this.tenant.operatorStepWithin(trx, (tx, operatorId) =>
      tx
        .insertInto("notification_outbox")
        .values({ id: randomUUID(), candidate_id: operatorId, application_id: null, kind: "cost_pause", local_day: null, payload: JSON.stringify(payload), created_at: facts.at, sent_at: null })
        .execute()
    )
  }
}

function refused(refusal: ReserveRefusal): Reservation {
  return { ok: false, refusal }
}
