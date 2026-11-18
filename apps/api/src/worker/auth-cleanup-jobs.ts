import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"

import { AuthTableCleanup, type AuthCleanupCounts } from "../auth/auth-table-cleanup.js"
import { JobQueue, sharedQueue } from "./job-queue.js"

export const AUTH_CLEANUP_QUEUE = "auth.cleanup"
/** Hourly: the request path no longer deletes expired attempts or idle sessions. */
export const AUTH_CLEANUP_CRON = "0 * * * *"
/** Housekeeping runs on whole wall-clock hours only, so no local boundary is involved. */
export const AUTH_CLEANUP_TIME_ZONE = "UTC"

/**
 * `auth.cleanup`: the one place stale `sign_in_attempt` rows (past the 10 minute
 * TTL) and idle `dashboard_session` rows (past the 14 day idle expiry) are
 * removed. It runs in the worker process only, on a shared queue: neither table
 * carries a Candidate scope, so the job needs no Candidate's rows.
 *
 * The singleton policy keeps one run active and `retryLimit: 0` because the
 * next hour's run catches up anyway, as `retention.daily` and the
 * access-request retention jobs do. A presented attempt or session is still
 * refused on its own TTL at use time; this is only housekeeping.
 */
@Injectable()
export class AuthCleanupJobs implements OnApplicationBootstrap {
  constructor(
    private readonly queue: JobQueue,
    private readonly cleanup: AuthTableCleanup
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = sharedQueue(AUTH_CLEANUP_QUEUE)
    await this.queue.createQueue(queue, { policy: "singleton", retryLimit: 0 })
    await this.queue.schedule(queue, AUTH_CLEANUP_CRON, { tz: AUTH_CLEANUP_TIME_ZONE })
    await this.queue.workShared(queue, { batchSize: 1 }, async () => {
      await this.run()
    })
  }

  /** One sweep, as the scheduled handler runs it. */
  async run(): Promise<AuthCleanupCounts> {
    return this.cleanup.run()
  }
}
