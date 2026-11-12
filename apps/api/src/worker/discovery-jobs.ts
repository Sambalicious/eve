import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"

import { CandidateScope } from "../db/candidate-scope.js"
import { TenantDatabase } from "../db/tenant-database.js"
import { DiscoveryPipeline, DISCOVERY_TIME_ZONE } from "../discovery/discovery-pipeline.js"
import { DiscoveryRepository } from "../discovery/discovery.repository.js"
import { evaluationAllowed } from "../discovery/evaluation-allowed.js"
import { EVALUATE_POSTING_QUEUE, EVALUATE_POSTING_QUEUE_OPTIONS } from "../discovery/evaluation-queue.js"
import { PostingEvaluator } from "../discovery/posting-evaluator.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { SpendLedger } from "../spend/spend-ledger.js"
import { type CandidateJobResult, CandidateJobRunner } from "./candidate-job-runner.js"
import { JobQueue, candidateQueue, sharedQueue } from "./job-queue.js"

export const DISCOVERY_DAILY_QUEUE = "discovery.daily"
export { EVALUATE_POSTING_QUEUE } from "../discovery/evaluation-queue.js"
export const SPEND_TICK_QUEUE = "spend.tick"
/** Shared schedules: each handler reads the Operator from the identity table (Operator-only until B/C/D). */
const DISCOVERY_DAILY = sharedQueue(DISCOVERY_DAILY_QUEUE)
const SPEND_TICK = sharedQueue(SPEND_TICK_QUEUE)
/** EPIC-0002 A2: a Candidate queue. Jobs queued before A2 carry only `postingId`, and all are the Operator's. */
export const EVALUATE_POSTING = candidateQueue<{ postingId: string }>(EVALUATE_POSTING_QUEUE, { legacyMissingIsOperator: true })
/** Every minute: the 00:00 WAT cost-pause rollover and releasing postings saved during a cost pause. */
export const SPEND_TICK_CRON = "* * * * *"
/** Postings released per tick; each still reserves its own cost, so the ceiling holds. */
const WAITING_BATCH = 50
/** 08:00 every day, Africa/Lagos (AC 3.1). */
export const DISCOVERY_CRON = "0 8 * * *"

/**
 * Registers the discovery jobs in the worker. `discovery.daily` uses the
 * singleton policy, so at most one run is active at a time. The schedule is
 * always registered; the handler itself checks the global pause and the
 * employer-list approval, so the run is a no-op until the Candidate approves
 * (AC 3.2) and resumes on its own once they do.
 *
 * EPIC-0002 A1 (architecture r2, Worker job scoping): Operator only until
 * slice B/C. Every handler runs in the Operator's scope.
 *
 * EPIC-0006 (contract v1.18.0 "Worker job payloads"): `evaluate.posting`
 * carries `{ postingId, candidateId? }`. Check again always sends
 * `candidateId`; jobs queued before A2 may omit it (Operator).
 * EPIC-0002 A2: it is a Candidate queue run by CandidateJobRunner. Before any
 * spend the runner refuses a missing or malformed ID, an unknown, revoked or
 * deleting Candidate, and a non-Operator until slice D converts `spend`
 * (EPIC-0002 D13; threat model TM-01): no model call and no write. The
 * handler also drops a malformed `postingId` and re-reads `evaluationAllowed`.
 * `spend.tick` releases only the Operator's visible waiting rows.
 */
export type EvaluatePostingJob = Readonly<{ postingId: string; candidateId?: string }>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
@Injectable()
export class DiscoveryJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(DiscoveryJobs.name)

  constructor(
    private readonly queue: JobQueue,
    private readonly runner: CandidateJobRunner,
    private readonly pipeline: DiscoveryPipeline,
    private readonly evaluator: PostingEvaluator,
    private readonly ledger: SpendLedger,
    private readonly repository: DiscoveryRepository,
    private readonly tenant: TenantDatabase,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { queue } = this
    await queue.createQueue(DISCOVERY_DAILY, { policy: "singleton", retryLimit: 0 })
    await queue.createQueue(EVALUATE_POSTING, EVALUATE_POSTING_QUEUE_OPTIONS)
    await queue.schedule(DISCOVERY_DAILY, DISCOVERY_CRON, { tz: DISCOVERY_TIME_ZONE })
    await queue.workShared(DISCOVERY_DAILY, {}, async () => {
      await this.runDiscovery()
    })
    await this.runner.work(EVALUATE_POSTING, {}, (candidateId, data) => this.evaluateInScope(candidateId, data.postingId))
    await queue.createQueue(SPEND_TICK, { policy: "singleton", retryLimit: 0 })
    await queue.schedule(SPEND_TICK, SPEND_TICK_CRON, { tz: DISCOVERY_TIME_ZONE })
    await queue.workShared(SPEND_TICK, { batchSize: 1 }, async () => {
      await this.spendTick()
    })
  }

  /**
   * r2: the cost pause clears at 00:00 WAT on the 1st. r4: once it is off
   * (rollover or a raised ceiling), postings saved during the pause are
   * evaluated, each through its own reservation, so evaluating them can pause
   * paid automation again before the month goes over its ceiling.
   */
  /**
   * One `evaluate.posting` job, through CandidateJobRunner as the worker runs
   * it: the runner refuses a missing, malformed, unknown, revoked or deleting
   * Candidate before the handler (TM-01).
   */
  evaluateJob(data: EvaluatePostingJob): Promise<CandidateJobResult> {
    return this.runner.run(EVALUATE_POSTING, data, (candidateId, job) => this.evaluateInScope(candidateId, job.postingId))
  }

  /** Inside the job Candidate's scope: drops a malformed posting ID or a Candidate evaluation does not serve yet, before any spend. */
  private async evaluateInScope(candidateId: string, postingId: unknown): Promise<void> {
    if (typeof postingId !== "string" || !UUID.test(postingId)) {
      this.logger.warn(JSON.stringify({ event: "evaluate.posting.dropped", reason: "malformed" }))
      return
    }
    if (!evaluationAllowed(await this.repository.candidateIdentity(candidateId))) {
      this.logger.warn(JSON.stringify({ event: "evaluate.posting.dropped", reason: "not_allowed", postingId, candidateId }))
      return
    }
    await this.evaluator.evaluate(postingId)
  }

  async spendTick(): Promise<number> {
    return this.tenant.asOperator(() => this.releaseWaiting())
  }

  private async releaseWaiting(): Promise<number> {
    if (await this.ledger.rollover()) this.logger.log("Cost pause cleared: a new month started")
    const control = await this.repository.readControl()
    if (control.cost_paused) return 0
    const candidates = await this.repository.waitingIds(WAITING_BATCH, this.clock.now())
    // v1.28.1: a transient failure is retried once without the Candidate pressing anything (migration 0036).
    const retries = await this.repository.retryFailedIds(WAITING_BATCH, this.clock.now())
    const ids = [...candidates, ...retries]
    const candidateId = CandidateScope.require()
    for (const postingId of ids) await this.queue.sendForCandidate(EVALUATE_POSTING, candidateId, { postingId }, { singletonKey: postingId })
    if (retries.length > 0) this.logger.log(JSON.stringify({ event: "discovery.retry_failed", retried: retries.length }))
    return ids.length
  }

  /**
   * EPIC-0006 r4 (AC-7.14, PROPOSAL P18): before the source read, so it runs
   * even when the read does not start (global pause, employer list not
   * approved). One job per re-queued posting, with no singletonKey: a lost job
   * still sitting in pg-boss must not swallow the re-queue, and a duplicate job
   * finds the evaluation running (lock) or finished (status) and does nothing
   * (AC-7.16). The spend tick never calls this.
   */
  private async requeueStuck(): Promise<number> {
    const { requeued, returnedHidden } = await this.repository.requeueStuck(this.clock.now())
    const candidateId = CandidateScope.require()
    for (const postingId of requeued) await this.queue.sendForCandidate(EVALUATE_POSTING, candidateId, { postingId })
    this.logger.log(JSON.stringify({ event: "discovery.stuck_requeued", requeued: requeued.length, returnedHidden }))
    return requeued.length
  }

  async runDiscovery(): Promise<void> {
    await this.tenant.asOperator(() => this.discover())
  }

  private async discover(): Promise<void> {
    // SEC-R-02: this recovers only the Operator today, because runDiscovery runs in the Operator scope and
    // evaluationAllowed (D13) is Operator-only. EPIC-0002 slice D must recover every Candidate's stuck rows,
    // pasted links and descriptions included (AC-7.14); until then an invitee's rows wait for their own Check again.
    // A failed recovery must not stop the source read; the next run or Check again recovers the rows.
    await this.requeueStuck().catch((error: unknown) => {
      this.logger.error(JSON.stringify({ event: "discovery.stuck_requeue_failed", error: error instanceof Error ? error.name : "unknown" }))
    })
    const summary = await this.pipeline.runDaily()
    if (!summary.started) {
      this.logger.log(`Discovery not started: ${summary.reason}`)
      return
    }
    const candidateId = CandidateScope.require()
    for (const postingId of summary.postingIdsToEvaluate) {
      await this.queue.sendForCandidate(EVALUATE_POSTING, candidateId, { postingId }, { singletonKey: postingId })
    }
    this.logger.log(
      `Discovery: ${summary.sourcesRead} sources read, ${summary.sourcesFailed} failed, ${summary.stored} new, ${summary.alreadyStored} already stored`
    )
  }
}
