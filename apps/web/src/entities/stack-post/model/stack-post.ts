import type { AlertFeedFailureReason, StackPostKind } from "@eve/contracts"

/**
 * Stack posts as the dashboard uses them (EPIC-0005, contract v1.14.0). No type
 * here carries a full Alert feed URL: after registration the web app only ever
 * holds the server-computed mask (D-E5-5, D-E5-2).
 */

export interface AlertFeedVerification {
  /** `YYYY-MM-DD`. */
  readonly verifiedOn: string
  readonly basis: string
}

export interface AlertFeedFailure {
  readonly reason: AlertFeedFailureReason
  /** ISO-8601. */
  readonly at: string
}

export interface AlertFeed {
  readonly id: string
  /** Null: show "Alert feed". */
  readonly label: string | null
  /** "…654321", computed by the server. */
  readonly maskedUrl: string
  /** Last successful read; the registration fetch counts. */
  readonly lastReadAt: string | null
  /** Null: healthy. */
  readonly failure: AlertFeedFailure | null
}

export interface AlertFeeds {
  /** Null: not verified. */
  readonly verification: AlertFeedVerification | null
  /** Oldest first, at most `limit`. */
  readonly feeds: readonly AlertFeed[]
  readonly limit: number
  /**
   * The global pause flag from this feeds response (contract v1.22.0, OWN-1).
   * Every Candidate gets it here; `GET /v1/controls` refuses invitees until slice D.
   */
  readonly globalPaused: boolean
}

export interface StackPostSource {
  readonly label: string | null
  readonly maskedUrl: string
}

export interface StackPost {
  readonly id: string
  /** `https://www.linkedin.com/posts/…` or `/pulse/…`. */
  readonly canonicalUrl: string
  readonly kind: StackPostKind
  /** Plain text; may be "". */
  readonly title: string
  /** Plain text; may be "". */
  readonly snippet: string
  readonly date: string
  /** "found": the feed had no usable date, so `date` is the first-seen time. */
  readonly dateKind: "posted" | "found"
  readonly matchedTechnologies: readonly string[]
  /** Null: the source feed was removed. */
  readonly source: StackPostSource | null
}

export interface StackPostsPage {
  readonly items: readonly StackPost[]
  readonly page: number
  readonly totalCount: number
  /** 0 when there are no posts. */
  readonly totalPages: number
}

/** What a registration returns to the UI: the new row without its URL, and how many posts it stored. */
export interface RegisteredAlertFeed {
  readonly feed: AlertFeed
  readonly storedPosts: number
}
