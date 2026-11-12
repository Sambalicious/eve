import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { sql } from "../db/sql.js"

import { TenantDatabase } from "../db/tenant-database.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { JobQueue, sharedQueue } from "./job-queue.js"

export const ACCESS_REQUEST_IP_HASH_QUEUE = "access-request-ip-hash"
export const ACCESS_REQUEST_RETENTION_QUEUE = "access-request-retention"
/** Every 15 minutes: hashes are gone within 15 minutes after 24 hours. */
export const ACCESS_REQUEST_IP_HASH_CRON = "*/15 * * * *"
export const ACCESS_REQUEST_RETENTION_CRON = "30 3 * * *"

const DAY_MS = 24 * 3_600_000
const RETENTION_MS = 90 * DAY_MS

/**
 * EPIC-0003 retention (AC 11.20, architecture.r1 7.12). `<=` comparisons, so a
 * job run at the exact boundary clears it. C36: installation data, so both jobs
 * run in `forInstallation` and never see a Candidate row.
 */
export class AccessRequestRetention {
  constructor(private readonly tenant: TenantDatabase) {}

  /** IP hashes and drop rows are kept 24 hours: as long as the per-IP window needs them. */
  async clearIpHashes(now: Date): Promise<{ cleared: number; drops: number }> {
    const cutoff = new Date(now.getTime() - DAY_MS)
    return this.tenant.forInstallation(async (trx) => {
      const cleared = await trx.updateTable("access_request").set({ ip_hash: null }).where("ip_hash", "is not", null).where("created_at", "<=", cutoff).executeTakeFirst()
      const drops = await trx.deleteFrom("access_request_drop").where("created_at", "<=", cutoff).executeTakeFirst()
      return { cleared: Number(cleared.numUpdatedRows), drops: Number(drops.numDeletedRows) }
    })
  }

  /**
   * Requests are deleted 90 days after receipt, sent or not. A window's outbox
   * row goes once its last request is gone, unless it is mid-send (a later run
   * removes it). Cap alerts go after 90 days too.
   */
  async deleteExpired(now: Date): Promise<{ requests: number; outbox: number }> {
    const cutoff = new Date(now.getTime() - RETENTION_MS)
    return this.tenant.forInstallation(async (trx) => {
      const requests = await trx.deleteFrom("access_request").where("created_at", "<=", cutoff).executeTakeFirst()
      const windows = await trx
        .deleteFrom("notification_outbox as o")
        .where("o.kind", "=", "access_request")
        .where("o.status", "<>", "sending")
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom("access_request as r").select(sql`1`.as("one")).whereRef("r.window_id", "=", "o.access_request_window_id"))))
        .executeTakeFirst()
      const caps = await trx.deleteFrom("notification_outbox").where("kind", "=", "access_request_cap").where("created_at", "<=", cutoff).executeTakeFirst()
      return { requests: Number(requests.numDeletedRows), outbox: Number(windows.numDeletedRows) + Number(caps.numDeletedRows) }
    })
  }
}

/** Schedules the two retention jobs (UTC, singleton, no retries: the next run catches up). */
@Injectable()
export class AccessRequestJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccessRequestJobs.name)
  private readonly retention: AccessRequestRetention

  constructor(
    private readonly queue: JobQueue,
    tenant: TenantDatabase,
    @Inject(CLOCK) private readonly clock: Clock
  ) {
    this.retention = new AccessRequestRetention(tenant)
  }

  async onApplicationBootstrap(): Promise<void> {
    const ipHash = sharedQueue(ACCESS_REQUEST_IP_HASH_QUEUE)
    const retention = sharedQueue(ACCESS_REQUEST_RETENTION_QUEUE)
    await this.queue.createQueue(ipHash, { policy: "singleton", retryLimit: 0 })
    await this.queue.schedule(ipHash, ACCESS_REQUEST_IP_HASH_CRON, { tz: "UTC" })
    await this.queue.workShared(ipHash, { batchSize: 1 }, async () => {
      const result = await this.retention.clearIpHashes(this.clock.now())
      if (result.cleared + result.drops > 0) this.logger.log(`Access requests: ${result.cleared} IP hashes cleared, ${result.drops} drop rows deleted`)
    })
    await this.queue.createQueue(retention, { policy: "singleton", retryLimit: 0 })
    await this.queue.schedule(retention, ACCESS_REQUEST_RETENTION_CRON, { tz: "UTC" })
    await this.queue.workShared(retention, { batchSize: 1 }, async () => {
      const result = await this.retention.deleteExpired(this.clock.now())
      if (result.requests + result.outbox > 0) this.logger.log(`Access requests: ${result.requests} deleted after 90 days, ${result.outbox} outbox rows removed`)
    })
  }
}
