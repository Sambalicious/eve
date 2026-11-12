import { Injectable } from "@nestjs/common"
import type { NotificationEmailType, NotificationStatus } from "@eve/contracts"

import type { NotificationKind } from "../db/schema.js"
import { AccessRequestOutboxRepository } from "./access-request-outbox.repository.js"
import { NotificationRepository } from "./notification.repository.js"

type CandidateEmailKind = Extract<NotificationKind, "confirmed" | "blocked" | "daily_summary">
const EMAIL_TYPE: Readonly<Record<CandidateEmailKind, NotificationEmailType>> = {
  confirmed: "confirmed_submission",
  blocked: "blocked_application",
  daily_summary: "daily_summary",
}

/** `GET /v1/notifications/status` (C-NOTIFY-1). Never returns the Gmail address or app password (AC 7.6). */
@Injectable()
export class NotificationStatusService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly installation: AccessRequestOutboxRepository
  ) {}

  /**
   * The session Candidate's outbox only; the sender flag is the shared singleton. EPIC-0003's
   * access-request rows are installation data (C36), so they never reach `pendingCount` or
   * `latestFailure`; their counts are read in the installation scope for the Operator only.
   */
  async status(): Promise<NotificationStatus> {
    const [senderConfigured, pendingCount, failure, costPause, isOperator] = await Promise.all([
      this.repository.senderConfigured(),
      this.repository.pendingCount(),
      this.repository.latestFailure(["confirmed", "blocked", "daily_summary"]),
      this.repository.latestFailure(["cost_pause"]),
      this.repository.isOperator(),
    ])
    const access = isOperator ? await this.installation.counts() : null
    return {
      senderConfigured,
      pendingCount,
      latestFailure:
        failure && isCandidateEmailKind(failure.kind)
          ? { failedAt: failure.last_failed_at.toISOString(), emailType: EMAIL_TYPE[failure.kind], applicationId: failure.application_id, watDay: failure.local_day }
          : null,
      costPauseEmailFailedAt: costPause ? costPause.last_failed_at.toISOString() : null,
      // EPIC-0003 (7.11): counts only, and (C36, architecture r4 "Home alert") only for the Operator; omitted otherwise.
      ...(access ? { accessRequests: { waiting: senderConfigured ? 0 : access.waiting, failed: access.failed } } : {}),
    }
  }
}

function isCandidateEmailKind(kind: NotificationKind): kind is CandidateEmailKind {
  return Object.hasOwn(EMAIL_TYPE, kind)
}
