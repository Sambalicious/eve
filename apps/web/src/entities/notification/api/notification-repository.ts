import { NOTIFICATION_STATUS_PATH, notificationStatusSchema, type NotificationStatus as NotificationStatusResponse } from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { NotificationFailure, NotificationStatus } from "../model/notification"

export async function fetchNotificationStatus(): Promise<NotificationStatus> {
  const response = await apiRequest(NOTIFICATION_STATUS_PATH)
  return toNotificationStatus(notificationStatusSchema.parse(await response.json()))
}

function toNotificationStatus(body: NotificationStatusResponse): NotificationStatus {
  return {
    senderConfigured: body.senderConfigured,
    pendingCount: body.pendingCount,
    latestFailure: latestOf(body),
    accessRequests: body.accessRequests ? { waiting: body.accessRequests.waiting, failed: body.accessRequests.failed } : null,
  }
}

/**
 * C-NOTIFY-1 shows only the latest failure. v1.11.0 reports a failed cost-pause
 * email (E4) in its own field, which links to `/settings#cost`; the newer of the two wins.
 */
function latestOf(body: NotificationStatusResponse): NotificationFailure | null {
  const other = body.latestFailure && toFailure(body.latestFailure)
  const costPause: NotificationFailure | null = body.costPauseEmailFailedAt
    ? { failedAt: body.costPauseEmailFailedAt, emailType: "cost_pause", targetPath: "/settings#cost" }
    : null
  if (!other || !costPause) return other ?? costPause
  return Date.parse(costPause.failedAt) > Date.parse(other.failedAt) ? costPause : other
}

/** The two Application emails open their Application; the daily summary has no page of its own, so it opens Home (api-contract v1.10.0). */
function toFailure(failure: NonNullable<NotificationStatusResponse["latestFailure"]>): NotificationFailure {
  return {
    failedAt: failure.failedAt,
    emailType: failure.emailType,
    targetPath: failure.applicationId ? `/applications/${failure.applicationId}` : "/dashboard",
  }
}
