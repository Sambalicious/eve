import { z } from "zod"

/** v1.10.0 (slice 6): notification sender status for the Home alert `C-NOTIFY-1`. */
export const NOTIFICATION_STATUS_PATH = "/v1/notifications/status"

/** `{email type}` in `C-NOTIFY-1`: Confirmed Submission, Blocked Application, daily summary. ("cost pause" arrives with slice 7.) */
export const notificationEmailTypeSchema = z.enum(["confirmed_submission", "blocked_application", "daily_summary"])
export type NotificationEmailType = z.infer<typeof notificationEmailTypeSchema>

export const notificationFailureSchema = z
  .object({
    /** When the last attempt failed. `{time WAT}` in `C-NOTIFY-1`. */
    failedAt: z.iso.datetime({ offset: true }),
    emailType: notificationEmailTypeSchema,
    /** "See what wasn't sent": `/applications/{applicationId}` for the two Application emails, null for the daily summary. */
    applicationId: z.uuid().nullable(),
    /** The summary's WAT day; null for the two Application emails. */
    watDay: z.iso.date().nullable(),
  })
  .strict()
export type NotificationFailure = z.infer<typeof notificationFailureSchema>

export const notificationStatusSchema = z
  .object({
    /**
     * True when the worker has Gmail SMTP settings (AC 7.5). The address and app
     * password are never returned (AC 7.6). False: nothing is sent and emails wait.
     */
    senderConfigured: z.boolean(),
    /** Emails not yet sent (waiting for a first send or a retry). */
    pendingCount: z.number().int().min(0),
    /** The latest email that failed every attempt, or null once a later email sent (`C-NOTIFY-1`). Cost-pause emails are reported in `costPauseEmailFailedAt`, not here. */
    latestFailure: notificationFailureSchema.nullable(),
    /**
     * v1.11.0: when the cost-pause email (E4) failed every attempt; null or absent when it sent or none failed.
     * C-NOTIFY-1 with `{email type}` "cost pause", linking to `/settings#cost`.
     */
    costPauseEmailFailedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    /**
     * v1.16.0 (EPIC-0003): access-request emails for the Home alert. Counts only, never
     * visitor data. `waiting`: windows not sent because the sender is unconfigured (0
     * when configured). `failed`: access-request and daily-cap emails that failed every
     * attempt. Neither kind is counted in `pendingCount` or `latestFailure`.
     */
    accessRequests: z.object({ waiting: z.number().int().min(0), failed: z.number().int().min(0) }).strict().optional(),
  })
  .strict()
export type NotificationStatus = z.infer<typeof notificationStatusSchema>
