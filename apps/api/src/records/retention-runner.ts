import { randomUUID } from "node:crypto"

import { Inject, Injectable, Logger } from "@nestjs/common"
import { sql } from "../db/sql.js"

import type { RetentionRunOutcome } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { GENERATING, IN_FLIGHT, OUTREACH_STALE_RUN_MS, OutreachRunInFlightError, PENDING_DECISION, PENDING_SAMPLE, deleteDetailsLocked, isBusy, outreachRunningIds } from "./details-deletion.js"
import { dueCreatedBefore, graceEndFrom, watDate } from "./expiry-date.js"
import { isWaiting } from "./retention-view.js"

/** E4.3: at most 100 Applications per transaction, the manual limit. */
export const RETENTION_BATCH_SIZE = 100
/** A runaway guard: 200 batches is 20,000 Applications in one run. The run is then marked failed. */
export const RETENTION_MAX_BATCHES = 200
/** QA-G5-2: the lock bound stays under the statement bound; both under the worker pool's 60 s. */
export const RETENTION_BATCH_TIMEOUTS = transactionTimeouts(5_000, 30_000)

export type RetentionRunSummary = Readonly<{
  /** The Candidate whose records this run covered; absent on the aggregate of a whole run. */
  candidateId?: string
  watDate: string
  outcome: Exclude<RetentionRunOutcome, "running">
  due: number
  deleted: number
  skippedInFlight: number
  skippedPendingDecision: number
  skippedLocked: number
  failed: number
  filesReleased: number
  batches: number
}>

type Counts = { due: number; deleted: number; skippedInFlight: number; skippedPendingDecision: number; skippedLocked: number; failed: number; filesReleased: number; batches: number }

/**
 * One run of automatic 12-month expiry (PRD E2 to E4, E6; architecture
 * "Job design"). It deletes through `deleteDetailsLocked`, the same code as the
 * manual endpoint, and differs only in how it picks rows: due by the date rule,
 * not busy (E3.5), not waiting on a Candidate decision (E3.6), not locked by
 * other work (FOR UPDATE SKIP LOCKED, E4.2). It makes no AI, browser,
 * discovery or email call and reserves no spend, so the cost pause does not
 * stop it (E3.4); the global pause does (E3.3).
 *
 * Files are not unlinked: the worker mounts the document volume read-only. The
 * names whose rows were deleted are counted as `files_released`, and the api's
 * hourly DocumentSweep removes them (E4.4, D-E4).
 *
 * Logs and the `retention_run` row carry counts only. Application ids appear
 * only in the warning for a failed batch (E6.3).
 *
 * EPIC-0002 A1 (merge 11): Applications and run rows are Candidate data. A run
 * reads the Candidate IDs from the identity table and expires each Candidate's
 * records in that Candidate's `CandidateTx`, one Candidate after another, with
 * their own launch grace and their own `retention_run` row. The global pause is
 * read in the shared scope. Nothing bypasses RLS. `run()` returns the counts
 * summed over every Candidate (the log line stays one per Candidate).
 */
@Injectable()
export class RetentionRunner {
  private readonly logger = new Logger(RetentionRunner.name)

  /**
   * The one batch delete, calling the shared `deleteDetailsLocked`. A field so an
   * integration test can stage the claim-after-snapshot race NEW-3 covers: a Run
   * that lands between the batch's snapshot and this call. Production never
   * replaces it.
   */
  deleteDetails: typeof deleteDetailsLocked = (trx, candidateId, rows, now, by) => deleteDetailsLocked(trx, candidateId, rows, now, by)

  constructor(
    private readonly tenant: TenantDatabase,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async run(): Promise<RetentionRunSummary> {
    const startedAt = this.clock.now()
    const runDate = watDate(startedAt)
    const summaries: RetentionRunSummary[] = []
    for (const candidateId of await this.tenant.candidateIds()) summaries.push(await this.runFor(candidateId, startedAt))
    return aggregate(runDate, summaries)
  }

  /** One Candidate's run, in that Candidate's scope (E2 to E4, E6). */
  private async runFor(candidateId: string, startedAt: Date): Promise<RetentionRunSummary> {
    const runDate = watDate(startedAt)
    const bound = dueCreatedBefore(runDate)
    const inScope = <T>(work: (tx: CandidateTx) => Promise<T>) => this.tenant.forCandidate(candidateId, work)

    if (await this.globalPaused()) return this.recordSkip(candidateId, runDate, startedAt, "skipped_global_paused", 0)

    const first = await inScope((tx) => tx.selectFrom("retention_run").select(sql<string | null>`min(wat_date)::text`.as("first")).where("candidate_id", "=", candidateId).executeTakeFirst())
    const graceEnd = graceEndFrom(first?.first ?? runDate)
    if (runDate < graceEnd) return this.recordSkip(candidateId, runDate, startedAt, "skipped_launch_grace", await this.dueCount(candidateId, bound))

    const runId = randomUUID()
    await inScope((tx) => tx.insertInto("retention_run").values({ candidate_id: candidateId, id: runId, wat_date: runDate, started_at: startedAt, finished_at: null, outcome: "running" }).execute())
    const counts: Counts = { due: 0, deleted: 0, skippedInFlight: 0, skippedPendingDecision: 0, skippedLocked: 0, failed: 0, filesReleased: 0, batches: 0 }
    let outcome: Exclude<RetentionRunOutcome, "running"> = "completed"
    try {
      counts.due = await this.dueCount(candidateId, bound)
      const result = await this.deleteInBatches(candidateId, bound, startedAt, counts)
      if (result.failedIds.length > 0 || result.capReached || result.unknownFailure) outcome = "failed"
      if (!result.pausedMidRun) await this.countSkipped(candidateId, bound, startedAt, result.failedIds, counts)
    } catch (error) {
      outcome = "failed"
      this.logger.warn(`Retention ${runDate}: run stopped by an error: ${errorCode(error)}`)
    }
    await inScope((tx) =>
      tx
      .updateTable("retention_run")
      .set({
        finished_at: this.clock.now(),
        outcome,
        due_count: counts.due,
        deleted_count: counts.deleted,
        skipped_in_flight: counts.skippedInFlight,
        skipped_pending_decision: counts.skippedPendingDecision,
        skipped_locked: counts.skippedLocked,
        failed_count: counts.failed,
        files_released: counts.filesReleased,
      })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", runId)
      .execute()
    )
    const summary: RetentionRunSummary = { candidateId, watDate: runDate, outcome, ...counts }
    this.logger.log(countsLine(summary))
    return summary
  }

  /**
   * E4.1 to E4.3: one transaction per batch; a failed batch rolls back alone and
   * the loop goes on. A row that gained an Outreach Run in flight after the
   * batch's snapshot is skipped, not failed (CR-9, NEW-3): `countSkipped` counts
   * it as in flight from the later read, and only that row is excluded from the
   * next batch, so the rest of its batch is still expired today.
   */
  private async deleteInBatches(candidateId: string, bound: Date, now: Date, counts: Counts): Promise<{ failedIds: string[]; capReached: boolean; unknownFailure: boolean; pausedMidRun: boolean }> {
    const failedIds: string[] = []
    const skippedInFlightIds: string[] = []
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
      // E3.3: a global pause turned on during the run stops the later batches.
      if (batch > 0 && (await this.globalPaused())) return { failedIds, capReached: false, unknownFailure: false, pausedMidRun: true }
      let selected: string[] = []
      try {
        const result = await this.tenant.forCandidate(candidateId, async (trx) => {
          await applyTransactionTimeouts(trx, RETENTION_BATCH_TIMEOUTS)
          // Postgres re-checks this WHERE on the locked row version, so a row that became busy or waiting is not returned (E4.1).
          let query = trx
            .selectFrom("application")
            .select(["id", "state", "submission_state", "details_deleted_at"])
            .where("candidate_id", "=", candidateId)
            .where("details_deleted_at", "is", null)
            .where("created_at", "<", bound)
            .where("state", "<>", GENERATING)
            .where((eb) => eb.or([eb("submission_state", "is", null), eb("submission_state", "not in", [...IN_FLIGHT, ...PENDING_DECISION])]))
            .where((eb) => eb.or([eb("sample_state", "is", null), eb("sample_state", "<>", PENDING_SAMPLE)]))
            // EPIC-0014 D3: an Application with an Outreach Run in flight is skipped, like a busy row.
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("outreach_message as om")
                    .select("om.id")
                    .whereRef("om.application_id", "=", "application.id")
                    .where("om.candidate_id", "=", candidateId)
                    .where("om.run_status", "=", "running")
                    .where("om.run_started_at", ">", new Date(now.getTime() - OUTREACH_STALE_RUN_MS))
                )
              )
            )
          const excluded = [...failedIds, ...skippedInFlightIds]
          if (excluded.length > 0) query = query.where("id", "not in", excluded)
          const rows = await query.orderBy("created_at").orderBy("id").limit(RETENTION_BATCH_SIZE).forUpdate().skipLocked().execute()
          selected = rows.map((row) => row.id)
          const deleted = await this.deleteDetails(trx, candidateId, rows, now, "expiry")
          return { size: rows.length, deleted: deleted.deletedIds.length, files: deleted.fileNames.length }
        })
        if (result.size > 0) counts.batches++
        counts.deleted += result.deleted
        counts.filesReleased += result.files
        if (result.size < RETENTION_BATCH_SIZE) return { failedIds, capReached: false, unknownFailure: false, pausedMidRun: false }
      } catch (error) {
        if (selected.length === 0) {
          this.logger.warn(`Retention: a batch failed before selecting rows: ${errorCode(error)}`)
          return { failedIds, capReached: false, unknownFailure: true, pausedMidRun: false }
        }
        // CR-9: a Run claimed the row after this batch read its snapshot, so the
        // repeated check refused the delete. The batch rolled back and nothing was
        // lost; the row is in flight, not broken, and `countSkipped` explains it.
        if (error instanceof OutreachRunInFlightError) {
          // NEW-3: only the rows with a live Run are excluded. The rolled-back
          // batch's other rows are due again, so one busy Application cannot
          // starve the rest of its batch for the day. The re-read uses the same
          // predicate and `now` as the check that threw, so it names the row
          // unless its Run already ended; a claim that lands again is found on a
          // later pass, and the batch cap bounds the retries.
          const running = await this.tenant.forCandidate(candidateId, (tx) => outreachRunningIds(tx, candidateId, selected, now))
          skippedInFlightIds.push(...running)
          continue
        }
        failedIds.push(...selected)
        counts.failed += selected.length
        // E6.3: the only place Application ids are logged. The error's code or name, never its message.
        this.logger.warn(`Retention: a batch of ${selected.length} failed (${errorCode(error)}): ${selected.join(", ")}`)
      }
    }
    return { failedIds, capReached: true, unknownFailure: false, pausedMidRun: false }
  }

  /** E3.5, E3.6, E4.2: what is still live and due after the loop, by reason. A row deleted by the Candidate meanwhile is not live, so not counted. */
  private async countSkipped(candidateId: string, bound: Date, now: Date, failedIds: readonly string[], counts: Counts): Promise<void> {
    const failed = new Set(failedIds)
    const { rows, running } = await this.tenant.forCandidate(candidateId, async (tx) => {
      const rows = await tx
        .selectFrom("application")
        .select(["id", "state", "submission_state", "sample_state"])
        .where("candidate_id", "=", candidateId)
        .where("details_deleted_at", "is", null)
        .where("created_at", "<", bound)
        .execute()
      // EPIC-0014 D3: an Outreach Run in flight is counted as in flight, the existing busy counter.
      return { rows, running: await outreachRunningIds(tx, candidateId, rows.map((row) => row.id), now) }
    })
    for (const row of rows) {
      if (failed.has(row.id)) continue
      if (isBusy(row) || running.has(row.id)) counts.skippedInFlight++
      else if (isWaiting(row)) counts.skippedPendingDecision++
      else counts.skippedLocked++
    }
  }

  private async dueCount(candidateId: string, bound: Date): Promise<number> {
    const row = await this.tenant.forCandidate(candidateId, (tx) =>
      tx
        .selectFrom("application")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("candidate_id", "=", candidateId)
        .where("details_deleted_at", "is", null)
        .where("created_at", "<", bound)
        .executeTakeFirstOrThrow()
    )
    return Number(row.n)
  }

  /** `control_state` is shared (architecture r4 Table classification): read in the shared scope. */
  private async globalPaused(): Promise<boolean> {
    const control = await this.tenant.forShared((tx) => tx.selectFrom("control_state").select("global_paused").executeTakeFirst())
    return control?.global_paused === true
  }

  private async recordSkip(candidateId: string, runDate: string, at: Date, outcome: "skipped_global_paused" | "skipped_launch_grace", due: number): Promise<RetentionRunSummary> {
    await this.tenant.forCandidate(candidateId, (tx) => tx.insertInto("retention_run").values({ candidate_id: candidateId, id: randomUUID(), wat_date: runDate, started_at: at, finished_at: at, outcome, due_count: due }).execute())
    const summary: RetentionRunSummary = { candidateId, watDate: runDate, outcome, due, deleted: 0, skippedInFlight: 0, skippedPendingDecision: 0, skippedLocked: 0, failed: 0, filesReleased: 0, batches: 0 }
    this.logger.log(countsLine(summary))
    return summary
  }
}

/**
 * The counts of one run summed over every Candidate. The outcome is the worst
 * one: failed, else completed if any Candidate's run completed, else the skip
 * every Candidate shared (paused before launch grace). No Candidates: completed, zero.
 */
export function aggregate(watDate: string, summaries: readonly RetentionRunSummary[]): RetentionRunSummary {
  const sum = (key: keyof Counts) => summaries.reduce((total, summary) => total + summary[key], 0)
  const outcomes = new Set(summaries.map((summary) => summary.outcome))
  const outcome: RetentionRunSummary["outcome"] = outcomes.has("failed")
    ? "failed"
    : outcomes.has("completed") || outcomes.size === 0
      ? "completed"
      : outcomes.has("skipped_global_paused")
        ? "skipped_global_paused"
        : "skipped_launch_grace"
  return {
    watDate,
    outcome,
    due: sum("due"),
    deleted: sum("deleted"),
    skippedInFlight: sum("skippedInFlight"),
    skippedPendingDecision: sum("skippedPendingDecision"),
    skippedLocked: sum("skippedLocked"),
    failed: sum("failed"),
    filesReleased: sum("filesReleased"),
    batches: sum("batches"),
  }
}

/** E6.3: counts only. */
export function countsLine(summary: RetentionRunSummary): string {
  if (summary.outcome === "skipped_global_paused") return `Retention ${summary.watDate}: skipped, automation is paused`
  if (summary.outcome === "skipped_launch_grace") return `Retention ${summary.watDate}: skipped, launch grace (would be due ${summary.due})`
  return (
    `Retention ${summary.watDate}: ${summary.outcome}, due ${summary.due}, deleted ${summary.deleted}, in flight ${summary.skippedInFlight}, ` +
    `pending decision ${summary.skippedPendingDecision}, locked ${summary.skippedLocked}, failed ${summary.failed}, files released ${summary.filesReleased}`
  )
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code
  return error instanceof Error ? error.name : "unknown"
}
