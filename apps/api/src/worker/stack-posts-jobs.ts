import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"

import { TenantDatabase } from "../db/tenant-database.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { type HiringReadRunResult, HiringPostsReader } from "../stack-posts/hiring-posts-reader.js"
import { type ReadRunResult, StackPostsReader, safeErrorSummary } from "../stack-posts/stack-posts-reader.js"
import { JobQueue, sharedQueue } from "./job-queue.js"

export const STACK_POSTS_READ_QUEUE = "stack-posts.read"
/** D-E5-8: 02:00, 08:00, 14:00 and 20:00 WAT. The 20:00 run precedes the 21:00 summary. */
export const STACK_POSTS_READ_CRON = "0 2,8,14,20 * * *"
export const STACK_POSTS_TIME_ZONE = "Africa/Lagos"
/**
 * SEC-P3-02 (threat model P3-11): one scheduled run must finish within the 6-hour
 * gap between cron ticks. The queue is a singleton, so a longer run makes the
 * next tick be skipped with no other signal; the run logs a warning instead.
 * EPIC-0008: both sequential per-Candidate loops (up to 10 Stack posts and 10
 * Hiring feeds each) fit about 43 Candidates when every feed fails (EPIC-0008
 * architecture "Scalability"); real reads take well under a second per feed.
 */
export const SCHEDULED_READ_WARN_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * SEC-E8-05: per-Candidate failures resolve the job, so pg-boss job state no longer shows them.
 * A run with any failed Candidate logs one error line with this stable event name and the counts
 * (no Candidate id, feed or URL). Operators alert on it: docs/ops/monitoring.md.
 */
export const SCHEDULED_READ_FAILURE_EVENT = "scheduled_read_candidate_failures"

/** One Candidate's Stack posts read in a scheduled run (EPIC-0008, AR-6). */
export type StackRunEntry = Readonly<{ candidateId: string; result: ReadRunResult | "not_active" | "failed" }>

/** One Candidate's Hiring read in a scheduled run. */
export type HiringRunEntry = Readonly<{ candidateId: string; result: HiringReadRunResult | "not_active" | "failed" }>

/**
 * Registers the scheduled feed read. Singleton with retries off, so a failed
 * run never re-runs early (AC 4.7); a fixed cron, so registering a feed or a
 * worker restart never shifts the times (AC 4.5). The handler checks the
 * global pause and the verification itself and records a skipped run.
 *
 * EPIC-0008 (api-contract.md v1.22.0, AR-6, AR-10): the Stack posts read runs
 * once for each active Candidate, in that Candidate's own scope, one after
 * another, each with its own try/catch and gated by that Candidate's own
 * Stack posts record. Then the Hiring read does the same (EPIC-0007 Phase 3,
 * threat model P3-14), gated by each Candidate's own Hiring record. A single
 * Candidate's failure is logged and never stops another read or fails the
 * job; only a failure of the Stack posts loop as a whole fails the job, after
 * the Hiring loop has run. No code sends a job to this queue: the cron slot
 * and the singleton policy keep one run per scheduled time (AR-11).
 */
@Injectable()
export class StackPostsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(StackPostsJobs.name)

  constructor(
    private readonly queue: JobQueue,
    private readonly reader: StackPostsReader,
    private readonly hiringReader: HiringPostsReader,
    private readonly tenant: TenantDatabase,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = sharedQueue(STACK_POSTS_READ_QUEUE)
    await this.queue.createQueue(queue, { policy: "singleton", retryLimit: 0 })
    await this.queue.schedule(queue, STACK_POSTS_READ_CRON, { tz: STACK_POSTS_TIME_ZONE })
    await this.queue.workShared(queue, { batchSize: 1 }, async () => {
      await this.runScheduled()
    })
  }

  /** One scheduled run: every Candidate's Stack posts read, then every Candidate's Hiring read. Neither stops the other. */
  async runScheduled(): Promise<Readonly<{ stack: readonly StackRunEntry[]; hiring: readonly HiringRunEntry[] }>> {
    const startedAt = this.clock.now().getTime()
    let stack: readonly StackRunEntry[] = []
    let stackError: unknown = null
    try {
      stack = await this.runStackReads()
    } catch (error) {
      this.logger.error(`Stack posts reads failed: ${safeErrorSummary(error)}`)
      stackError = error
    }
    let hiring: readonly HiringRunEntry[] = []
    try {
      hiring = await this.runHiringReads()
    } catch (error) {
      this.logger.error(`Hiring posts reads failed: ${safeErrorSummary(error)}`)
    }
    this.warnIfOverrun(startedAt, Math.max(stack.length, hiring.length))
    this.reportCandidateFailures(stack, hiring)
    if (stackError !== null) throw stackError
    return { stack, hiring }
  }

  /** SEC-E8-05: one line per run with any failed Candidate; counts only. The per-Candidate lines name the ids. */
  private reportCandidateFailures(stack: readonly StackRunEntry[], hiring: readonly HiringRunEntry[]): void {
    const failed = (entries: readonly { result: unknown }[]) => entries.filter((entry) => entry.result === "failed").length
    const stackFailed = failed(stack)
    const hiringFailed = failed(hiring)
    if (stackFailed + hiringFailed === 0) return
    this.logger.error(
      `Scheduled feed read finished with failed Candidates: event=${SCHEDULED_READ_FAILURE_EVENT} stack_failed=${stackFailed} hiring_failed=${hiringFailed} candidates=${Math.max(stack.length, hiring.length)}`
    )
  }

  /** SEC-P3-02: elapsed minutes and the Candidate count only; no Candidate id, feed or URL. */
  private warnIfOverrun(startedAt: number, candidates: number): void {
    const elapsed = this.clock.now().getTime() - startedAt
    if (elapsed <= SCHEDULED_READ_WARN_AFTER_MS) return
    const minutes = (ms: number) => Math.floor(ms / 60_000)
    this.logger.warn(
      `Stack posts scheduled read took ${minutes(elapsed)} min, over the ${minutes(SCHEDULED_READ_WARN_AFTER_MS)} min limit (Candidates: ${candidates}); the next scheduled run may be skipped`
    )
  }

  /**
   * AR-6: every Candidate id from the identity table, sequentially. A Candidate
   * whose state is not `active` is skipped with no run row and no request. Each
   * Candidate's run is its own scope and its own try/catch; the log line names
   * the Candidate id and a safe error summary, never a feed URL or the basis.
   */
  async runStackReads(): Promise<StackRunEntry[]> {
    return this.tenant.eachCandidate(async (candidateId): Promise<StackRunEntry> => {
      try {
        const identity = await this.tenant.candidateIdentity(candidateId)
        if (identity?.state !== "active") return { candidateId, result: "not_active" }
        return { candidateId, result: await this.reader.runRead() }
      } catch (error) {
        this.logger.error(`Stack posts read for Candidate ${candidateId} failed: ${safeErrorSummary(error)}`)
        return { candidateId, result: "failed" }
      }
    })
  }

  /**
   * P3-14: every Candidate id from the identity table, sequentially. A Candidate
   * whose state is not `active` is skipped with no run row and no request. Each
   * Candidate's run is its own scope and its own try/catch; nothing carries from
   * one Candidate to the next.
   */
  async runHiringReads(): Promise<HiringRunEntry[]> {
    const results = await this.tenant.eachCandidate(async (candidateId): Promise<HiringRunEntry> => {
      try {
        const identity = await this.tenant.candidateIdentity(candidateId)
        if (identity?.state !== "active") return { candidateId, result: "not_active" }
        return { candidateId, result: await this.hiringReader.runRead() }
      } catch (error) {
        this.logger.error(`Hiring posts read for Candidate ${candidateId} failed: ${safeErrorSummary(error)}`)
        return { candidateId, result: "failed" }
      }
    })
    return results
  }
}
