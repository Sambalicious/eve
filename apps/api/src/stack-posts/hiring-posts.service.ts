import { Inject, Injectable, Logger } from "@nestjs/common"
import {
  type AlertFeedVerificationRequest,
  HIRING_ALERT_FEED_LIMIT,
  type HiringAlertFeedsResponse,
  type HiringPostsResponse,
  type RegisterAlertFeedRequest,
  type RegisterAlertFeedResponse,
  STACK_POSTS_PAGE_SIZE,
  type StackPostsFieldError,
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
import { HiringPostsRepository } from "./hiring-posts.repository.js"
import { toStackPosts } from "./stack-post-builder.js"
import type { FeedsState, VerificationRow } from "./stack-posts.repository.js"
import { REGISTRATION_RETRY_AFTER_SECONDS, toAlertFeed } from "./stack-posts.service.js"

const fieldError = (field: StackPostsFieldError["field"], problem: StackPostsFieldError["problem"]): ApiException =>
  ApiException.badRequestWithFieldErrors([{ field, position: null, problem }])

/** Field by field, never a row spread (threat model P3-6). */
function toVerification(row: VerificationRow | null): HiringAlertFeedsResponse["verification"] {
  return row ? { verifiedOn: row.verifiedOn, verificationBasis: row.verificationBasis, updatedAt: row.updatedAt.toISOString() } : null
}

/** OWN-1: `globalPaused` is the flag only, so invitees see the pause note without `GET /v1/controls`. */
function toResponse(state: FeedsState): HiringAlertFeedsResponse {
  return { verification: toVerification(state.verification), feeds: state.feeds.map(toAlertFeed), limit: HIRING_ALERT_FEED_LIMIT, globalPaused: state.globalPaused }
}

/**
 * EPIC-0007 Phase 3 (api-contract.r1.md): Hiring Alert feeds, the Candidate's
 * own permitted-use record (D14) and Hiring posts. Business rules here, data
 * access in `HiringPostsRepository`; the only outbound call is `AlertFeedHttp`.
 * No role check, no AI call, no spend, no discovery code (AC 10.1, 10.2).
 * Logs carry the feed id and mask, and never the basis or a feed URL.
 */
@Injectable()
export class HiringPostsService {
  private readonly logger = new Logger(HiringPostsService.name)

  constructor(
    private readonly repository: HiringPostsRepository,
    @Inject(ALERT_FEED_HTTP) private readonly http: AlertFeedHttp,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async feeds(): Promise<HiringAlertFeedsResponse> {
    return toResponse(await this.repository.feedsWithVerification())
  }

  /** Today in WAT, the latest date a verification may carry. */
  today(): string {
    return watDay(this.clock.now())
  }

  /** AC 6.6: upsert of the caller's own record (last save wins). Allowed in both pauses. The body is already validated. */
  async saveVerification(request: AlertFeedVerificationRequest): Promise<HiringAlertFeedsResponse> {
    if (request.verifiedOn > this.today()) throw fieldError("verifiedOn", "future_date")
    const state = await this.repository.saveVerification(request.verifiedOn, request.verificationBasis, this.clock.now())
    this.logger.log(`Hiring feed verification saved for Candidate ${CandidateScope.require()}`)
    return toResponse(state)
  }

  /**
   * Binding check order (api-contract.r1.md steps 4 to 9): the caller's own
   * record → 409, limit, duplicate, in_other_list, one fetch, then the locked
   * insert that re-checks the same four in the same order. Allowed during both pauses.
   */
  async register(request: RegisterAlertFeedRequest): Promise<RegisterAlertFeedResponse> {
    if (!(await this.repository.verification())) throw new ApiException("alert_feeds_not_verified")
    if ((await this.repository.feedCount()) >= HIRING_ALERT_FEED_LIMIT) throw fieldError("url", "limit_reached")
    if (await this.repository.feedUrlExists(request.url)) throw fieldError("url", "duplicate")
    if (await this.repository.feedUrlInStackList(request.url)) throw fieldError("url", "in_other_list")

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
      if (isLockTimeout(error)) {
        this.logger.warn(`Hiring Alert feed registration (${maskAlertFeedUrl(request.url)}) refused: database lock wait timed out`)
        throw ApiException.serviceUnavailable(REGISTRATION_RETRY_AFTER_SECONDS)
      }
      throw error
    }
    if (result.kind === "refused") {
      if (result.reason === "not_verified") throw new ApiException("alert_feeds_not_verified")
      throw fieldError("url", result.reason)
    }
    this.logger.log(`Hiring Alert feed ${result.feed.id} (${maskAlertFeedUrl(request.url)}) registered, ${result.storedPosts} Hiring posts stored`)
    return { feed: { ...toAlertFeed(result.feed), url: result.feed.url }, storedPosts: result.storedPosts }
  }

  async remove(id: string): Promise<void> {
    await this.repository.deleteFeed(id)
  }

  async posts(page: number): Promise<HiringPostsResponse> {
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
    this.logger.warn(`Hiring Alert feed registration (${maskAlertFeedUrl(url)}) refused: ${reason}`)
    return fieldError("url", reason)
  }
}
