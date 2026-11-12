import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"

import { TenantDatabase } from "../db/tenant-database.js"
import { NotificationSender } from "../notification/notification-sender.js"
import { AccessRequestOutboxRepository } from "../notification/access-request-outbox.repository.js"
import { NotificationRepository } from "../notification/notification.repository.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { watDay } from "../submission/wat-day.js"
import { JobQueue, WORKER_CONFIG, sharedQueue } from "./job-queue.js"
import type { WorkerConfig } from "./worker.config.js"

export const NOTIFICATION_SEND_QUEUE = "notification.send"
export const DAILY_SUMMARY_QUEUE = "notification.daily-summary"
/** Every minute: due outbox rows and their retries. */
export const NOTIFICATION_SEND_CRON = "* * * * *"
/**
 * 21:00 WAT: after the 08:00 discovery and 09:00 submission runs and their
 * follow-up work (design-spec r4 F7.3: "after that day's discovery and
 * submissions finish"). The design gives no clock time; OPEN[designer].
 */
export const DAILY_SUMMARY_CRON = "0 21 * * *"

/**
 * Notification jobs. The sender is scheduled always and does nothing without
 * Gmail settings. The daily summary is scheduled only when enabled
 * (NOTIFY_DAILY_SUMMARY_ENABLED=1), like discovery stays inert until approved.
 * Both queues are singletons with retries off: retries are the sender's own,
 * per outbox row.
 *
 * EPIC-0002 A1 (architecture r2, Worker job scoping): Operator only until
 * slice F. The send and summary jobs run in the Operator's scope, so they
 * claim and summarise Operator rows only; boot recovery iterates Candidates.
 */
@Injectable()
export class NotificationJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationJobs.name)

  constructor(
    private readonly queue: JobQueue,
    private readonly sender: NotificationSender,
    private readonly repository: NotificationRepository,
    private readonly installation: AccessRequestOutboxRepository,
    private readonly tenant: TenantDatabase,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const now = this.clock.now()
    await this.repository.recordSenderState(this.sender.configured, now)
    const perCandidate = (await this.tenant.eachCandidate(() => this.repository.failInterrupted(now))).reduce((sum, count) => sum + count, 0)
    // C36: access-request rows are installation data, recovered in their own scope.
    const interrupted = perCandidate + (await this.installation.failInterrupted(now))
    if (interrupted > 0) this.logger.warn(`Marked ${interrupted} interrupted notification(s) failed; they are not resent`)
    if (!this.sender.configured) this.logger.warn(`Notifications off: Gmail SMTP not configured${(this.config.mailerMissing ?? []).length > 0 ? ` (check ${(this.config.mailerMissing ?? []).join(", ")})` : ""}`)

    const send = sharedQueue(NOTIFICATION_SEND_QUEUE)
    const summary = sharedQueue(DAILY_SUMMARY_QUEUE)
    await this.queue.createQueue(send, { policy: "singleton", retryLimit: 0 })
    await this.queue.schedule(send, NOTIFICATION_SEND_CRON, { tz: "Africa/Lagos" })
    await this.queue.workShared(send, { batchSize: 1 }, async () => {
      await this.sendDue()
    })
    await this.queue.createQueue(summary, { policy: "singleton", retryLimit: 0 })
    if (this.config.dailySummaryEnabled) {
      await this.queue.schedule(summary, DAILY_SUMMARY_CRON, { tz: "Africa/Lagos" })
      await this.queue.workShared(summary, { batchSize: 1 }, async () => {
        await this.enqueueDailySummary()
      })
    } else {
      await this.queue.unschedule(summary)
    }
  }

  async sendDue() {
    const result = await this.tenant.asOperator(() => this.sender.sendDue())
    if (result.sent + result.retrying + result.failed > 0) this.logger.log(`Notifications: ${result.sent} sent, ${result.retrying} to retry, ${result.failed} failed`)
    return result
  }

  /** AC 7.3: one summary per WAT day, queued for the sender; a rerun the same day adds nothing. */
  async enqueueDailySummary(): Promise<boolean> {
    const now = this.clock.now()
    const created = await this.tenant.asOperator(() => this.repository.enqueueDailySummary(watDay(now), now))
    if (created) await this.sendDue()
    return created
  }
}
