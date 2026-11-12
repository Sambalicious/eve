import { Inject, Injectable } from "@nestjs/common"
import type { RetentionResponse } from "@eve/contracts"
import { sql } from "../db/sql.js"

import { TenantDatabase } from "../db/tenant-database.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { effectiveExpiry, watDate } from "./expiry-date.js"
import { readGraceEnd, retentionClass } from "./retention-view.js"

/** E4.5: a run still recorded `running` after this long counts as failed. */
export const STALE_RUN_MS = 60 * 60 * 1000

/**
 * `GET /v1/retention` (PRD E5.2, E5.5, E5.6, E6.4). Counts and dates only: no
 * company, role or requisition. The counts use the same date rule and the same
 * classification as the job and the `?retention=` list filter.
 *
 * EPIC-0002 A1 (merge 11): the session Candidate's Applications and runs only,
 * read in one `CandidateTx` that names `candidate_id` (RLS backs it up).
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly tenant: TenantDatabase,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async read(): Promise<RetentionResponse> {
    const now = this.clock.now()
    const today = watDate(now)
    const { graceEnd, live, runs } = await this.tenant.run(async (tx, candidateId) => ({
      graceEnd: await readGraceEnd(tx, candidateId, now),
      live: await tx
        .selectFrom("application")
        .select(["created_at", "state", "submission_state", "sample_state", "details_deleted_at"])
        .where("candidate_id", "=", candidateId)
        .where("details_deleted_at", "is", null)
        .execute(),
      runs: await tx
        .selectFrom("retention_run")
        .select([sql<string>`wat_date::text`.as("wat_date"), "outcome", "started_at", "deleted_count"])
        .where("candidate_id", "=", candidateId)
        .orderBy("wat_date", "desc")
        .orderBy("started_at", "desc")
        .limit(400)
        .execute(),
    }))
    let due = 0
    let earliestOn: string | null = null
    let overdue = 0
    let waiting = 0
    for (const row of live) {
      const kind = retentionClass(row, today, graceEnd)
      if (kind === "due") {
        due++
        const expiry = effectiveExpiry(row.created_at, graceEnd)
        if (earliestOn === null || expiry < earliestOn) earliestOn = expiry
      } else if (kind === "overdue") overdue++
      else if (kind === "waiting") waiting++
    }
    const outcomeOf = (run: (typeof runs)[number]) => (run.outcome === "running" ? (now.getTime() - run.started_at.getTime() > STALE_RUN_MS ? "failed" : null) : run.outcome)
    const finished = runs.filter((run) => outcomeOf(run) !== null)
    const latest = finished[0]
    const lastCompleted = finished.findIndex((run) => outcomeOf(run) === "completed")
    const failure = finished.slice(0, lastCompleted === -1 ? finished.length : lastCompleted).find((run) => outcomeOf(run) === "failed")
    return {
      rule: { months: 12 },
      dueNext30Days: { count: due, earliestOn },
      overdueDue: { count: overdue },
      waitingForDecision: { count: waiting },
      graceEndsOn: today < graceEnd ? graceEnd : null,
      lastRun: latest ? { watDate: latest.wat_date, outcome: outcomeOf(latest)!, deletedCount: latest.deleted_count } : null,
      lastFailure: failure ? { watDate: failure.wat_date } : null,
    }
  }
}
