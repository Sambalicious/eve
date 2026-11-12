import { Inject, Injectable, Logger } from "@nestjs/common"
import { maskAlertFeedUrl } from "@eve/contracts"

import { CLOCK, type Clock } from "../shared/clock.js"
import { ALERT_FEED_HTTP } from "./alert-feed-http.provider.js"
import { AlertFeedError, type AlertFeedHttp } from "./alert-feed-http.js"
import { NotAFeedError, parseAlertFeed } from "./alert-feed-parser.js"
import { type HiringRunCounts, type HiringRunOutcome, HiringPostsRepository } from "./hiring-posts.repository.js"
import { type CandidateStackPost, type MatchCriteria, toStackPosts } from "./stack-post-builder.js"
import { safeErrorSummary } from "./stack-posts-reader.js"

export type HiringReadRunResult = Readonly<{ outcome: HiringRunOutcome } & HiringRunCounts>

/**
 * EPIC-0007 Phase 3 (api-contract.r1.md "Scheduled read", threat model P3-14):
 * one Hiring read run for the scope Candidate. The worker calls it once per
 * active Candidate, each in that Candidate's own scope.
 *
 * Order: run row; global pause (never the cost pause); the Candidate's own
 * Hiring feed verification, else `skipped_unverified` with no request; one GET
 * per Hiring Alert feed through `ALERT_FEED_HTTP` with the board retries, each
 * with its own try/catch; retention; finish. A skipped run (global pause, no
 * record) still applies retention (OWN-4). Holds no Candidate state between
 * calls: every value is read through the repository inside the call.
 * Logs carry the feed id and mask, never the URL.
 */
@Injectable()
export class HiringPostsReader {
  private readonly logger = new Logger(HiringPostsReader.name)

  constructor(
    private readonly repository: HiringPostsRepository,
    @Inject(ALERT_FEED_HTTP) private readonly http: AlertFeedHttp,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async runRead(): Promise<HiringReadRunResult> {
    const runId = await this.repository.startRun(this.clock.now())
    // OWN-4 (owner decision 2026-10-29 17:29Z), as CR-E8-02 for Stack posts: retention is housekeeping, not a read.
    // Both skip paths still prune this Candidate's Hiring posts (90 days, newest 2,000) and old run rows. No request.
    const skip = async (outcome: "skipped_global_pause" | "skipped_unverified"): Promise<HiringReadRunResult> => {
      const counts = { feedsRead: 0, feedsFailed: 0, postsStored: 0, postsDeleted: await this.repository.applyRetention(this.clock.now()) }
      await this.repository.finishRun(runId, this.clock.now(), outcome, counts)
      this.logger.log(`Hiring posts read ${runId} skipped: ${outcome}, ${counts.postsDeleted} deleted`)
      return { outcome, ...counts }
    }
    if (await this.repository.globalPaused()) return skip("skipped_global_pause")
    if (!(await this.repository.verification())) return skip("skipped_unverified")

    const feeds = await this.repository.feeds()
    const criteria = await this.repository.criteria()
    let feedsRead = 0
    let feedsFailed = 0
    let postsStored = 0
    for (const feed of feeds) {
      const name = `Hiring Alert feed ${feed.id} (${maskAlertFeedUrl(feed.url)})`
      try {
        const body = await this.http.get(feed.url, { retries: true, stillWanted: () => this.repository.feedExists(feed.id) })
        if (body === null) continue
        const stored = await this.repository.recordRead(feed.id, buildPosts(body, criteria, this.clock.now()), this.clock.now())
        if (stored === null) continue
        feedsRead += 1
        postsStored += stored
      } catch (error) {
        feedsFailed += 1
        if (error instanceof AlertFeedError && error.reason !== "url_not_allowed") {
          this.logger.warn(`${name} read failed: ${error.reason}`)
          await this.repository.recordFailure(feed.id, error.reason, this.clock.now()).catch((recordError: unknown) => this.logInternal(name, recordError))
        } else {
          // As CR-E5-03: an internal error (including a stored URL the allowlist refuses) leaves the feed's state alone.
          this.logInternal(name, error)
        }
      }
    }
    const postsDeleted = await this.repository.applyRetention(this.clock.now())
    const counts = { feedsRead, feedsFailed, postsStored, postsDeleted }
    await this.repository.finishRun(runId, this.clock.now(), "completed", counts)
    this.logger.log(`Hiring posts read ${runId}: ${feedsRead} feeds read, ${feedsFailed} failed, ${postsStored} new, ${postsDeleted} deleted`)
    return { outcome: "completed", ...counts }
  }

  private logInternal(name: string, error: unknown): void {
    this.logger.error(`${name} read failed: internal error ${safeErrorSummary(error)}`)
  }
}

/** Feed body to rows. A body that is not a feed is the `not_a_feed` fetch failure; anything else thrown is internal. */
function buildPosts(body: string, criteria: MatchCriteria, now: Date): CandidateStackPost[] {
  try {
    return toStackPosts(parseAlertFeed(body), criteria, now)
  } catch (error) {
    if (error instanceof NotAFeedError) throw new AlertFeedError("not_a_feed")
    throw error
  }
}
