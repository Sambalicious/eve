import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common"
import type { Transaction } from "kysely"
import { PgBoss, fromKysely } from "pg-boss"

import { APP_CONFIG } from "../config/config.module.js"
import type { SharedRuntimeConfig } from "../config/env.js"
import { CandidateScope } from "../db/candidate-scope.js"
import type { Database } from "../db/schema.js"

/**
 * EPIC-0006 (architecture.r1 "Check again"): the api's send-only producer for
 * `evaluate.posting`, modelled on SampleSubmissionQueue (no supervision, no
 * schedules, no migrations: the runtime role has no DDL rights). Jobs are
 * inserted in the caller's transaction, so a Check again claim and its jobs
 * commit or roll back together. The queue name and options are the worker's.
 *
 * EPIC-0002 A2: a job names the scope Candidate only (as SampleSubmissionQueue
 * does); the worker's CandidateJobRunner checks that Candidate again before
 * the handler runs.
 */
export const EVALUATE_POSTING_QUEUE = "evaluate.posting"
export const EVALUATE_POSTING_QUEUE_OPTIONS = { policy: "standard", retryLimit: 2, retryDelay: 60, retryBackoff: true } as const

@Injectable()
export class EvaluationQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(EvaluationQueue.name)
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

  /** One job `{ postingId, candidateId }` per id, written in `trx`. Job data carries ids only. */
  async enqueue(trx: Transaction<Database>, candidateId: string, postingIds: readonly string[]): Promise<void> {
    if (candidateId !== CandidateScope.require()) throw new Error("Refused an evaluate.posting job: it may name only the scope Candidate")
    if (postingIds.length === 0) return
    await this.start()
    await this.boss.insert(
      EVALUATE_POSTING_QUEUE,
      postingIds.map((postingId) => ({ data: { postingId, candidateId } })),
      { db: fromKysely(trx) }
    )
  }

  /** Once; a failed start is tried again on the next press. */
  private start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start()
      await this.boss.createQueue(EVALUATE_POSTING_QUEUE, EVALUATE_POSTING_QUEUE_OPTIONS)
    })().catch((error: unknown) => {
      this.started = null
      throw error
    })
    return this.started
  }
}
