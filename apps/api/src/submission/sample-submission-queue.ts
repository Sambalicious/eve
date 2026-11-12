import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common"
import type { Transaction } from "kysely"
import { PgBoss, fromKysely } from "pg-boss"

import { APP_CONFIG } from "../config/config.module.js"
import type { SharedRuntimeConfig } from "../config/env.js"
import { CandidateScope } from "../db/candidate-scope.js"
import type { Database } from "../db/schema.js"

/**
 * F-QA5-01: the queue an approved Activation Gate sample waits in until the
 * worker, which owns the browser (ADR 0008), submits it. `singleton` with the
 * Application ID as key: at most one job per Application runs at a time. No
 * retries, so nothing is ever clicked twice.
 */
export const SAMPLE_SUBMISSION_QUEUE = "submission.sample"
export const SAMPLE_SUBMISSION_QUEUE_OPTIONS = { policy: "singleton", retryLimit: 0 } as const

/** EPIC-0002 A2: `candidateId` names the Candidate the sample belongs to; the worker's CandidateJobRunner reads it. */
export type SampleSubmissionJob = Readonly<{ applicationId: string; candidateId: string }>

/**
 * The api's send-only pg-boss client: no supervision, no schedules, no
 * migrations (the runtime role has no DDL rights, SEC-001). It starts on the
 * first approval, so the api still boots and answers health checks while the
 * database is down (CR-04). The job is written in the caller's transaction,
 * so an approval and its job commit together.
 */
@Injectable()
export class SampleSubmissionQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(SampleSubmissionQueue.name)
  private readonly boss: PgBoss
  private started: Promise<void> | null = null

  constructor(@Inject(APP_CONFIG) config: SharedRuntimeConfig) {
    this.boss = new PgBoss({ connectionString: config.databaseUrl, migrate: false, supervise: false, schedule: false, max: 2 })
    this.boss.on("error", (error: Error) => this.logger.error(`pg-boss: ${error.message}`))
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.started) return
    await this.started.catch(() => undefined)
    await this.boss.stop({ graceful: true }).catch(() => undefined)
  }

  async enqueue(trx: Transaction<Database>, applicationId: string): Promise<void> {
    await this.start()
    const job: SampleSubmissionJob = { applicationId, candidateId: CandidateScope.require() }
    await this.boss.send(SAMPLE_SUBMISSION_QUEUE, job, { singletonKey: applicationId, db: fromKysely(trx) })
  }

  /** Once; a failed start is tried again on the next approval. */
  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start()
      await this.boss.createQueue(SAMPLE_SUBMISSION_QUEUE, SAMPLE_SUBMISSION_QUEUE_OPTIONS)
    })().catch((error: unknown) => {
      this.started = null
      throw error
    })
    return this.started
  }
}
