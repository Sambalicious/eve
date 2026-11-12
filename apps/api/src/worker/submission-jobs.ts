import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"

import type { PrepareSamplesResult } from "@eve/contracts"

import { TenantDatabase } from "../db/tenant-database.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { SAMPLE_SUBMISSION_QUEUE, SAMPLE_SUBMISSION_QUEUE_OPTIONS, type SampleSubmissionJob } from "../submission/sample-submission-queue.js"
import { type SampleRunOutcome, SampleSubmissionRunner } from "../submission/sample-submission-runner.js"
import { SampleService } from "../submission/sample.service.js"
import { SubmissionRepository } from "../submission/submission.repository.js"
import { type DailyRunSummary, SubmissionService } from "../submission/submission.service.js"
import { CandidateJobRunner } from "./candidate-job-runner.js"
import { JobQueue, candidateQueue, sharedQueue } from "./job-queue.js"

export const SUBMISSION_DAILY_QUEUE = "submission.daily"
/** 09:00 every day, Africa/Lagos: after the 08:00 discovery run. Each attempt re-checks gate, pause and cap. */
export const SUBMISSION_CRON = "0 9 * * *"
const SUBMISSION_DAILY = sharedQueue(SUBMISSION_DAILY_QUEUE)
/**
 * EPIC-0002 A2 (architecture r3 "Fail closed before conversion"): the payload
 * carries `candidateId`; one queued before it did is the Operator's; a
 * non-Operator's job is refused until slice E converts submission.
 */
export const SAMPLE_SUBMISSION = candidateQueue<Omit<SampleSubmissionJob, "candidateId">>(SAMPLE_SUBMISSION_QUEUE, { legacyMissingIsOperator: true, operatorOnlyUntil: "submission" })

/**
 * The submission job (architecture r1: queue concurrency 1, retries off). The
 * singleton policy keeps one run active; `retryLimit: 0` means a failed run is
 * never retried, so nothing is clicked twice. The handler refuses before the
 * Activation Gate passes and while automatic submission is off, so the
 * schedule is harmless in every real environment until the Candidate acts.
 */
@Injectable()
export class SubmissionJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(SubmissionJobs.name)

  constructor(
    private readonly queue: JobQueue,
    private readonly runner: CandidateJobRunner,
    private readonly submissions: SubmissionService,
    private readonly samples: SampleService,
    private readonly sampleRunner: SampleSubmissionRunner,
    private readonly repository: SubmissionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenant: TenantDatabase
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { queue } = this
    // SEC-508: recovery runs here, in the worker, before this worker takes any job.
    await this.recoverInterrupted()
    await queue.createQueue(SUBMISSION_DAILY, { policy: "singleton", retryLimit: 0 })
    await queue.schedule(SUBMISSION_DAILY, SUBMISSION_CRON, { tz: "Africa/Lagos" })
    await queue.workShared(SUBMISSION_DAILY, { batchSize: 1 }, async () => {
      await this.runSamples()
      await this.runSubmissions()
    })
    // F-QA5-01: approved samples, one at a time, each attempted once.
    await queue.createQueue(SAMPLE_SUBMISSION, SAMPLE_SUBMISSION_QUEUE_OPTIONS)
    await this.recoverLostSamples()
    await this.runner.work(SAMPLE_SUBMISSION, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 1 }, async (_candidateId, data) => {
      await this.runSample(data.applicationId)
    })
  }

  /** ADR 0005: in-flight attempts whose browser lease is gone become Uncertain. Never fatal to the worker. */
  async recoverInterrupted(): Promise<number | "lease_held" | "failed"> {
    try {
      const recovered = await this.submissions.recoverInterrupted()
      if (recovered === "lease_held") this.logger.warn("Another worker holds the browser lease; in-flight submissions left alone")
      else if (recovered > 0) this.logger.warn(`Marked ${recovered} interrupted submission(s) Uncertain`)
      return recovered
    } catch (error) {
      this.logger.error(`Could not recover interrupted submissions: ${error instanceof Error ? error.name : "unknown"}`)
      return "failed"
    }
  }

  /** Worker start: an approved sample whose job is gone (stopped before the claim) goes back to review, per Candidate. */
  async recoverLostSamples(): Promise<number> {
    const counts = await this.tenant.eachCandidate(() => this.repository.returnLostSamplesToReview(SAMPLE_SUBMISSION_QUEUE, this.clock.now()))
    const returned = counts.reduce((sum, count) => sum + count, 0)
    if (returned > 0) this.logger.warn(`Returned ${returned} approved sample(s) with no job to review`)
    return returned
  }

  /** Runs inside the job Candidate's scope (CandidateJobRunner): only the Operator's before slice E. */
  private async runSample(applicationId: string): Promise<SampleRunOutcome> {
    const outcome = await this.sampleRunner.run(applicationId)
    this.logger.log(`Sample ${applicationId}: ${outcome.result}${"refusal" in outcome ? ` (${outcome.refusal})` : ""}`)
    return outcome
  }

  /**
   * Before the gate passes: prepares the samples the five still need, then
   * reads (never fills) each new sample's form so its review lists every
   * planned answer. A no-op after the gate, while paused, or without an
   * approved Career Profile; without a browser the forms stay unread.
   */
  async runSamples(): Promise<{ prepared: PrepareSamplesResult; formsRead: number }> {
    return this.tenant.asOperator(() => this.prepareSamples())
  }

  private async prepareSamples(): Promise<{ prepared: PrepareSamplesResult; formsRead: number }> {
    const prepared = await this.samples.prepare()
    let formsRead = 0
    for (const id of await this.samples.awaitingWithoutFormRead()) {
      const result = await this.submissions.readForm(id).catch(() => "failed" as const)
      if (result === "read") formsRead += 1
      if (result === "paused" || result === "browser_unavailable") break
    }
    this.logger.log(`Samples: ${prepared.created} prepared (stopped by ${prepared.stoppedBy ?? "nothing"}), ${formsRead} forms read`)
    return { prepared, formsRead }
  }

  /** EPIC-0002 A1: Operator only until slice E (architecture r2, Worker job scoping). */
  async runSubmissions(): Promise<DailyRunSummary> {
    const summary = await this.tenant.asOperator(() => this.submissions.runDaily())
    this.logger.log(`Submission run: ${summary.submitted} submitted, ${summary.carriedOver} carried over, stopped by ${summary.stoppedBy ?? "nothing"}`)
    return summary
  }
}
