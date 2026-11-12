/** The email a failure was about: `{email type}` in C-NOTIFY-1. */
export type NotificationEmailType = "confirmed_submission" | "blocked_application" | "daily_summary" | "cost_pause"

/** The latest email that failed every attempt (C-NOTIFY-1). */
export interface NotificationFailure {
  readonly failedAt: string
  readonly emailType: NotificationEmailType
  /** "See what wasn't sent": the Application the email was about, Home for the daily summary, `/settings#cost` for the cost pause. */
  readonly targetPath: string
}

/**
 * Unsent access-request emails (v1.16.0), counts only, never visitor data.
 * `waiting`: held because the sender isn't configured. `failed`: failed every attempt.
 */
export interface AccessRequestCounts {
  readonly waiting: number
  readonly failed: number
}

/** Notification sender state for Home (`GET /v1/notifications/status`). */
export interface NotificationStatus {
  readonly senderConfigured: boolean
  readonly pendingCount: number
  /** Null when nothing failed, or once a later email sent. */
  readonly latestFailure: NotificationFailure | null
  /** Null when the API doesn't report them (an invitee after EPIC-0002, or an older API). */
  readonly accessRequests: AccessRequestCounts | null
}
