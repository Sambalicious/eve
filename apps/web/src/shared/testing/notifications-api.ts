import {
  NOTIFICATION_STATUS_PATH,
  notificationStatusSchema,
  type NotificationFailure,
  type NotificationStatus,
} from "@eve/contracts"
import { http, HttpResponse } from "msw"

/** A `latestFailure` from `GET /v1/notifications/status` (v1.10.0): a Confirmed Submission email at 10:15 WAT. */
export function notificationFailure(overrides: Partial<NotificationFailure> = {}): NotificationFailure {
  return {
    failedAt: "2026-10-20T09:15:00.000Z",
    emailType: "confirmed_submission",
    applicationId: "0b6f7a52-3c1d-4f4e-9a8b-2c6d1e0f9a11",
    watDay: null,
    ...overrides,
  }
}

/** `GET /v1/notifications/status`, parsed through the contract so a fixture can't drift from it. */
export function notificationStatusHandler(overrides: Partial<NotificationStatus> = {}) {
  const body = notificationStatusSchema.parse({ senderConfigured: true, pendingCount: 0, latestFailure: null, ...overrides })
  return http.get(NOTIFICATION_STATUS_PATH, () => HttpResponse.json(body, { headers: { "cache-control": "no-store" } }))
}

/** Default: the sender isn't configured yet and nothing has failed (a new installation). */
export const freshNotificationHandlers = [notificationStatusHandler({ senderConfigured: false })]
