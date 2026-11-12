import { Inject, Injectable, Logger } from "@nestjs/common"
import {
  ALERT_FEED_LIMIT,
  type AlertFeed,
  type AlertFeedVerificationRequest,
  type AlertFeedsResponse,
  type HiringSearchInputsResponse,
  type RegisterAlertFeedRequest,
  type RegisterAlertFeedResponse,
  STACK_POSTS_PAGE_SIZE,
  type StackPostsFieldError,
  type StackPostsResponse,
  maskAlertFeedUrl,
} from "@eve/contracts"

import { CandidateScope } from "../db/candidate-scope.js"
import { isLockTimeout } from "../db/transaction-timeouts.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { watDay } from "../submission/wat-day.js"
import { ALERT_FEED_HTTP } from "./alert-feed-http.provider.js"
import { AlertFeedError, type AlertFeedHttp } from "./alert-feed-http.js"
import { NotAFeedError, parseAlertFeed } from "./alert-feed-parser.js"
import { toStackPosts } from "./stack-post-builder.js"
import { type FeedRow, type FeedsState, StackPostsRepository, type VerificationRow } from "./stack-posts.repository.js"

/** Contract v1.15.2: Retry-After on a registration lock timeout; 3 s of lock wait plus margin. */
export const REGISTRATION_RETRY_AFTER_SECONDS = 5

const fieldError = (field: StackPostsFieldError["field"], problem: StackPostsFieldError["problem"]): ApiException =>
  ApiException.badRequestWithFieldErrors([{ field, position: null, problem }])

export function toAlertFeed(row: FeedRow): AlertFeed {
  return {
    id: row.id,
    label: row.label,
    maskedUrl: maskAlertFeedUrl(row.url),
    createdAt: row.createdAt.toISOString(),
    lastReadAt: row.lastReadAt?.toISOString() ?? null,
    failure: row.failureReason && row.failedAt ? { reason: row.failureReason, at: row.failedAt.toISOString() } : null,
  }
}

function toVerification(row: VerificationRow | null): AlertFeedsResponse["verification"] {
  return row ? { verifiedOn: row.verifiedOn, verificationBasis: row.verificationBasis, updatedAt: row.updatedAt.toISOString() } : null
}

/** OWN-1: `globalPaused` is the flag only, so invitees see the pause note without `GET /v1/controls`. */
function toFeedsResponse(read: FeedsState): AlertFeedsResponse {
  return { verification: toVerification(read.verification), feeds: read.feeds.map(toAlertFeed), limit: ALERT_FEED_LIMIT, globalPaused: read.globalPaused }
}

/**
 * Stack posts API (architecture "API sketch", "Registration flow"). Business
 * rules live here; data access in the repository; the only outbound call is
 * `AlertFeedHttp`. No AI call, no spend (AC 6.5). Never logs a feed URL.
 */
@Injectable()
export class StackPostsService {
  private readonly logger = new Logger(StackPostsService.name)

  constructor(
    private readonly repository: StackPostsRepository,
    @Inject(ALERT_FEED_HTTP) private readonly http: AlertFeedHttp,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** v1.22.0: the caller's own record (or null) and feeds, from one `CandidateTx`. Feeds may be non-empty while the record is null (OD-7). */
  async feeds(): Promise<AlertFeedsResponse> {
    return toFeedsResponse(await this.repository.feedsWithVerification())
  }

  /**
   * EPIC-0007 Phase 1: hint terms for the Hiring view. Not gated by the
   * verification or either pause; no outbound request, no AI, no write.
   */
  async hiringSearchInputs(): Promise<HiringSearchInputsResponse> {
    return { hintTerms: await this.repository.hiringHints() }
  }

  /** Today in WAT, the latest date a verification may carry (AC 3.2). */
  today(): string {
    return watDay(this.clock.now())
  }

  /**
   * v1.22.0 (EPIC-0008, AR-3): upsert of the caller's own record; any Candidate, no role check. A date after
   * today in WAT is refused (also checked with the other field rules, CR-E5-01). The basis is never logged (BE-1).
   */
  async saveVerification(request: AlertFeedVerificationRequest): Promise<AlertFeedsResponse> {
    if (request.verifiedOn > this.today()) throw fieldError("verifiedOn", "future_date")
    const saved = await this.repository.saveVerification(request.verifiedOn, request.verificationBasis, this.clock.now())
    this.logger.log(`Stack posts feed verification saved for Candidate ${CandidateScope.require()}`)
    return toFeedsResponse(saved)
  }

  /**
   * Binding check order: (body already validated) verification → 409, limit,
   * duplicate, (EPIC-0007 Phase 3) in_other_list, one fetch, then a locked
   * insert that re-checks all four.
   * Allowed during the global pause (AC 6.6).
   */
  async register(request: RegisterAlertFeedRequest): Promise<RegisterAlertFeedResponse> {
    if (!(await this.repository.verification())) throw new ApiException("alert_feeds_not_verified")
    if ((await this.repository.feedCount()) >= ALERT_FEED_LIMIT) throw fieldError("url", "limit_reached")
    if (await this.repository.feedUrlExists(request.url)) throw fieldError("url", "duplicate")
    if (await this.repository.feedUrlInHiringList(request.url)) throw fieldError("url", "in_other_list")

    let body: string | null
    try {
      body = await this.http.get(request.url, { retries: false })
    } catch (error) {
      if (error instanceof AlertFeedError && error.reason !== "url_not_allowed") throw this.fetchRefusal(request.url, error.reason)
      throw fieldError("url", "invalid_format")
    }
    let posts
    try {
      posts = toStackPosts(parseAlertFeed(body ?? ""), await this.repository.criteria(), this.clock.now())
    } catch (error) {
      if (error instanceof NotAFeedError) throw this.fetchRefusal(request.url, "not_a_feed")
      throw error
    }

    let result
    try {
      result = await this.repository.insertFeedWithPosts(request.url, request.label, posts, this.clock.now())
    } catch (error) {
      // Architecture r4 item 3: a lock wait past REGISTER_FEED_TIMEOUTS rolled back; nothing is stored. Not retried here.
      if (isLockTimeout(error)) {
        this.logger.warn(`Alert feed registration (${maskAlertFeedUrl(request.url)}) refused: database lock wait timed out`)
        throw ApiException.serviceUnavailable(REGISTRATION_RETRY_AFTER_SECONDS)
      }
      throw error
    }
    if (result.kind === "refused") {
      if (result.reason === "not_verified") throw new ApiException("alert_feeds_not_verified")
      throw fieldError("url", result.reason)
    }
    this.logger.log(`Alert feed ${result.feed.id} (${maskAlertFeedUrl(request.url)}) registered, ${result.storedPosts} posts stored`)
    return { feed: { ...toAlertFeed(result.feed), url: result.feed.url }, storedPosts: result.storedPosts }
  }

  async remove(id: string): Promise<void> {
    await this.repository.deleteFeed(id)
  }

  async posts(page: number): Promise<StackPostsResponse> {
    const { rows, totalCount } = await this.repository.page(page)
    return {
      page,
      pageSize: STACK_POSTS_PAGE_SIZE,
      totalCount,
      totalPages: Math.ceil(totalCount / STACK_POSTS_PAGE_SIZE),
      items: rows.map((row) => ({
        id: row.id,
        canonicalUrl: row.canonicalUrl,
        kind: row.kind,
        title: row.title,
        snippet: row.snippet,
        date: (row.publishedAt ?? row.firstSeenAt).toISOString(),
        dateKind: row.publishedAt ? "posted" : "found",
        matchedTechnologies: row.matchedTechnologies,
        source: row.sourceUrl === null ? null : { label: row.sourceLabel, maskedUrl: maskAlertFeedUrl(row.sourceUrl) },
        firstSeenAt: row.firstSeenAt.toISOString(),
      })),
    }
  }

  private fetchRefusal(url: string, reason: Exclude<AlertFeedError["reason"], "url_not_allowed">): ApiException {
    this.logger.warn(`Alert feed registration (${maskAlertFeedUrl(url)}) refused: ${reason}`)
    return fieldError("url", reason)
  }
}
