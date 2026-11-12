import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"

import { RetentionRunner } from "../records/retention-runner.js"
import { JobQueue, WORKER_CONFIG, sharedQueue } from "./job-queue.js"
import type { WorkerConfig } from "./worker.config.js"

export const RETENTION_DAILY_QUEUE = "retention.daily"
/** 03:00 every day, Africa/Lagos (PRD E3.1, D-E2): after the 21:00 summary and the 00:00 rollover, before 08:00 discovery. */
export const RETENTION_CRON = "0 3 * * *"
export const RETENTION_TIME_ZONE = "Africa/Lagos"

/**
 * Automatic 12-month expiry in the worker. The singleton policy keeps one run
 * active; `retryLimit: 0` because the next day's run catches up anyway (E3.2).
 * The operator switch RETENTION_JOB_DISABLED=1 unschedules it at start (E3.8);
 * it is not a Candidate setting and no API changes it (D-E8).
 */
@Injectable()
export class RetentionJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionJobs.name)

  constructor(
    private readonly queue: JobQueue,
    private readonly runner: RetentionRunner,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = sharedQueue(RETENTION_DAILY_QUEUE)
    await this.queue.createQueue(queue, { policy: "singleton", retryLimit: 0 })
    if (this.config.retentionJobDisabled === true) {
      await this.queue.unschedule(queue)
      this.logger.warn("Automatic expiry off: RETENTION_JOB_DISABLED=1")
      return
    }
    await this.queue.schedule(queue, RETENTION_CRON, { tz: RETENTION_TIME_ZONE })
    await this.queue.workShared(queue, { batchSize: 1 }, async () => {
      await this.runner.run()
    })
  }
}
