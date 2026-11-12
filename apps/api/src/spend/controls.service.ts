import { Inject, Injectable } from "@nestjs/common"
import type { Controls, CostActionValue, RaiseCeilingResponse } from "@eve/contracts"
import { sql } from "../db/sql.js"

import { TenantDatabase } from "../db/tenant-database.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { ceilingRefusalMessage, checkNewCeiling } from "./ceiling-rules.js"
import { SPEND_CONFIG } from "./spend-config.js"
import { SpendLedger } from "./spend-ledger.js"
import { MAX_CEILING_MICROS, type SpendConfig, firstOfNextMonth, formatUsd, startOfWatMonth, watMonth } from "./spend-math.js"

/**
 * The dashboard's pause and cost controls (AC 10.1, 10.2; design-spec r4 F10).
 * The global pause is the Candidate's; the cost pause is the backend's and is
 * never changed by the global pause control.
 * EPIC-0002 A1: `control_state` is shared (the global pause and global cost
 * pause), read and written in `forShared` transactions.
 */
@Injectable()
export class ControlsService {
  constructor(
    private readonly tenant: TenantDatabase,
    private readonly ledger: SpendLedger,
    @Inject(SPEND_CONFIG) private readonly spend: SpendConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async controls(): Promise<Controls> {
    const month = await this.ledger.month()
    const control = await this.tenant.forShared((tx) =>
      tx
        .selectFrom("control_state")
        .select(["global_paused", "global_paused_at", "cost_paused", "cost_paused_at", "cost_pause_action", "cost_pause_estimate_micros", sql<string | null>`cost_paused_month::text`.as("cost_paused_month")])
        .executeTakeFirstOrThrow()
    )
    const costPause =
      control.cost_paused && control.cost_paused_at !== null && control.cost_paused_month !== null
        ? {
            pausedAt: control.cost_paused_at.toISOString(),
            month: control.cost_paused_month,
            resumesAt: startOfWatMonth(firstOfNextMonth(control.cost_paused_month)).toISOString(),
            nextAction: control.cost_pause_action as CostActionValue | null,
            nextActionEstimate: control.cost_pause_estimate_micros === null ? null : formatUsd(Number(control.cost_pause_estimate_micros)),
          }
        : null
    const byCategory = Object.fromEntries(Object.entries(month.byCategory).map(([key, micros]) => [key, formatUsd(micros)])) as Controls["spend"]["byCategory"]
    return {
      globalPaused: control.global_paused,
      globalPausedAt: control.global_paused ? (control.global_paused_at?.toISOString() ?? null) : null,
      costPause,
      spend: {
        month: month.month,
        spent: formatUsd(month.spent),
        ceiling: formatUsd(month.ceiling),
        defaultCeiling: formatUsd(this.spend.ceilingMicros),
        raised: month.raisedAt !== null,
        maxCeiling: formatUsd(MAX_CEILING_MICROS),
        canRaise: month.ceiling < MAX_CEILING_MICROS && month.spent < MAX_CEILING_MICROS,
        percentUsed: Math.floor((month.spent * 100) / month.ceiling),
        byCategory,
      },
    }
  }

  /**
   * AC 10.1. Turning it on twice keeps the first time; turning it off never
   * touches the cost pause or the Activation Gate (global-pause.feature).
   */
  async setGlobalPause(paused: boolean): Promise<Controls> {
    const now = this.clock.now()
    await this.tenant.forShared((tx) =>
      tx
        .updateTable("control_state")
        .set(paused ? { global_paused: true, global_paused_at: sql`case when global_paused then global_paused_at else ${now}::timestamptz end` } : { global_paused: false, global_paused_at: null })
        .execute()
    )
    return this.controls()
  }

  /** r2/r3: the current WAT month only, at most USD 100.00, above both the current ceiling and this month's spend. */
  async raiseCeiling(month: string, input: string): Promise<RaiseCeilingResponse> {
    if (month !== watMonth(this.clock.now())) throw new ApiException("bad_request")
    const current = await this.ledger.month()
    const figures = { currentMicros: current.ceiling, spentMicros: current.spent }
    const check = checkNewCeiling(input, figures)
    if (!check.ok) return { result: "refused", refusal: check.code, message: ceilingRefusalMessage(check.code, figures) }
    const costPauseCleared = await this.ledger.raiseCeiling(current.month, check.ceilingMicros)
    return { result: "raised", controls: await this.controls(), costPauseCleared }
  }
}
