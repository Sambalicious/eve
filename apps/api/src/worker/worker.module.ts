import { type DynamicModule, Module } from "@nestjs/common"

import { ConfigModule } from "../config/config.module.js"
import type { SharedRuntimeConfig } from "../config/env.js"
import { WORKER_STATEMENT_TIMEOUT_MS } from "../db/create-database.js"
import { DatabaseModule } from "../db/database.module.js"
import { type FilesConfig, FilesModule } from "../files/files.module.js"
import { DiscoveryWorkerModule } from "../discovery/discovery.module.js"
import { NotificationWorkerModule } from "../notification/notification.module.js"
import { ClockModule } from "../shared/clock.js"
import { RetentionRunner } from "../records/retention-runner.js"
import { SpendModule } from "../spend/spend.module.js"
import { StackPostsWorkerModule } from "../stack-posts/stack-posts.module.js"
import { SubmissionWorkerModule } from "../submission/submission.module.js"
import { CandidateJobRunner } from "./candidate-job-runner.js"
import { DiscoveryJobs } from "./discovery-jobs.js"
import { JobQueue, WORKER_CONFIG } from "./job-queue.js"
import { NotificationJobs } from "./notification-jobs.js"
import { AccessRequestJobs } from "./access-request-jobs.js"
import { RetentionJobs } from "./retention-jobs.js"
import { StackPostsJobs } from "./stack-posts-jobs.js"
import { SubmissionJobs } from "./submission-jobs.js"
import { WorkerHeartbeat } from "./worker-heartbeat.js"
import type { WorkerConfig } from "./worker.config.js"

/**
 * The worker gets only the shared config: the database URL (DatabaseModule) and the
 * Anthropic settings (ModelGateway). Dashboard OAuth secrets are never loaded here.
 * Discovery's providers inject nothing else from APP_CONFIG.
 */
export function workerAppConfig(config: WorkerConfig): SharedRuntimeConfig & FilesConfig {
  return { databaseUrl: config.databaseUrl, statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS, anthropic: config.anthropic, candidateStorageDir: config.candidateStorageDir, formAgentEnabled: config.formAgentEnabled === true, documentBridgesEnabled: config.documentBridgesEnabled === true, documentDirectionEnabled: config.documentDirectionEnabled === true, ...(config.spend ? { spend: config.spend } : {}) }
}

/** The `worker` process: scheduled and queued jobs (slice 3: discovery and posting evaluation; slice 5: submission; slice 6: notifications; EPIC-0005: Stack posts reads; automatic 12-month expiry). */
@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [ConfigModule.forRoot(workerAppConfig(config)), ClockModule, DatabaseModule, FilesModule, SpendModule, DiscoveryWorkerModule, SubmissionWorkerModule.forRoot(config.browser ?? null), NotificationWorkerModule.forRoot(config.mailer ?? null), StackPostsWorkerModule],
      // JobQueue first: Nest runs bootstrap hooks in order, so the heartbeat starts after pg-boss.
      providers: [{ provide: WORKER_CONFIG, useValue: config }, JobQueue, CandidateJobRunner, DiscoveryJobs, SubmissionJobs, NotificationJobs, AccessRequestJobs, StackPostsJobs, RetentionRunner, RetentionJobs, WorkerHeartbeat],
      exports: [JobQueue],
    }
  }
}
