import { type DynamicModule, Module } from "@nestjs/common"

import { SpendModule } from "../spend/spend.module.js"
import { StackPostsWorkerModule } from "../stack-posts/stack-posts.module.js"

import { GmailSmtpMailer, MAILER, type Mailer, unconfiguredMailer } from "./mailer.js"
import type { MailerConfig } from "./mailer-config.js"
import { MAILER_CONFIG, NotificationSender } from "./notification-sender.js"
import { NotificationStatusService } from "./notification-status.service.js"
import { NotificationController } from "./notification.controller.js"
import { AccessRequestOutboxRepository } from "./access-request-outbox.repository.js"
import { NotificationRepository } from "./notification.repository.js"

/** The api's view: the read-only status for `C-NOTIFY-1`. The api never holds Gmail settings. */
@Module({
  controllers: [NotificationController],
  providers: [NotificationRepository, AccessRequestOutboxRepository, NotificationStatusService],
})
export class NotificationModule {}

/**
 * The worker's view: the outbox sender. With `config: null` the Mailer is never
 * called and rows stay pending. `mailer` replaces the Gmail SMTP adapter (tests).
 */
@Module({})
export class NotificationWorkerModule {
  static forRoot(config: MailerConfig | null, options: Readonly<{ mailer?: Mailer }> = {}): DynamicModule {
    const mailer = options.mailer ?? (config ? new GmailSmtpMailer(config) : unconfiguredMailer)
    return {
      module: NotificationWorkerModule,
      imports: [SpendModule, StackPostsWorkerModule],
      providers: [NotificationRepository, AccessRequestOutboxRepository, NotificationSender, { provide: MAILER_CONFIG, useValue: config }, { provide: MAILER, useValue: mailer }],
      exports: [NotificationSender, NotificationRepository, AccessRequestOutboxRepository],
    }
  }
}
