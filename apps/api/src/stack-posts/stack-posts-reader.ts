import { Inject, Injectable, Logger } from "@nestjs/common"
import { maskAlertFeedUrl } from "@eve/contracts"

import { CLOCK, type Clock } from "../shared/clock.js"
import { ALERT_FEED_HTTP } from "./alert-feed-http.provider.js"
import { AlertFeedError, type AlertFeedHttp } from "./alert-feed-http.js"
import { NotAFeedError, parseAlertFeed } from "./alert-feed-parser.js"
import { type CandidateStackPost, type MatchCriteria, toStackPosts } from "./stack-post-builder.js"
import { StackPostsRepository } from "./stack-posts.repository.js"

export type ReadRunResult = Readonly<{
  outcome: "completed" | "skipped_global_pause" | "skipped_unverified"
  feedsRead: number
  feedsFailed: number
  postsStored: number
  postsDeleted: number
}>

/**
 * One scheduled read run (architecture "Scheduled read flow"): pause and
 * verification checks (EPIC-0008: the scope Candidate's own record, so the
 * worker runs this once per active Candidate in that Candidate's scope), then every feed in turn with its own try/catch, then
 * retention. A skipped run (global pause, no record) still applies retention (CR-E8-02). Reads the global pause only, never the cost pause (AC 6.5, 6.6).
 * Logs carry the feed id and mask, never the URL (AC 7.4).
 */
@Injectable()
export class StackPostsReader {
  private readonly logger = new Logger(StackPostsReader.name)

  constructor(
    private readonly repository: StackPostsRepository,
    @Inject(ALERT_FEED_HTTP) private readonly http: AlertFeedHttp,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async runRead(): Promise<ReadRunResult> {
    const runId = await this.repository.startRun(this.clock.now())
    // CR-E8-02 (owner decision 2026-10-29): retention is housekeeping, not a read. It runs on both skip paths too, so a
    // Candidate without her own record, or any Candidate during the global pause, still has her posts age out
    // (90 days, newest 2,000) as C-SP-POSTS-UNVERIFIED-NOTE says. It makes no request and reads no feed.
    const skip = async (outcome: "skipped_global_pause" | "skipped_unverified"): Promise<ReadRunResult> => {
      const counts = { feedsRead: 0, feedsFailed: 0, postsStored: 0, postsDeleted: await this.repository.applyRetention(this.clock.now()) }
      await this.repository.finishRun(runId, this.clock.now(), outcome, counts)
      this.logger.log(`Stack posts read skipped: ${outcome}, ${counts.postsDeleted} deleted`)
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
      const name = `Alert feed ${feed.id} (${maskAlertFeedUrl(feed.url)})`
      try {
        // EPIC-0008 SFS:296: a feed removed while an earlier feed of hers was being read gets no request.
        if (!(await this.repository.feedExists(feed.id))) continue
        const body = await this.http.get(feed.url, { retries: true, stillWanted: () => this.repository.feedExists(feed.id) })
        if (body === null) continue
        const stored = await this.repository.recordRead(feed.id, this.buildPosts(feed.id, body, criteria), this.clock.now())
        if (stored === null) continue
        feedsRead += 1
        postsStored += stored
      } catch (error) {
        feedsFailed += 1
        if (error instanceof AlertFeedError && error.reason !== "url_not_allowed") {
          this.logger.warn(`${name} read failed: ${error.reason}`)
          await this.repository.recordFailure(feed.id, error.reason, this.clock.now()).catch((recordError: unknown) => this.logInternal(name, recordError))
        } else {
          // CR-E5-03 (architecture.r1.md item 2): an internal error is a fact about Eve, not the feed. The feed's
          // stored state is left alone; the run counts it and the log names the error, never its message.
          this.logInternal(name, error)
        }
      }
    }
    const postsDeleted = await this.repository.applyRetention(this.clock.now())
    const counts = { feedsRead, feedsFailed, postsStored, postsDeleted }
    await this.repository.finishRun(runId, this.clock.now(), "completed", counts)
    this.logger.log(`Stack posts read: ${feedsRead} feeds read, ${feedsFailed} failed, ${postsStored} new, ${postsDeleted} deleted`)
    return { outcome: "completed", ...counts }
  }

  /** Feed body to rows. A body that is not a feed is the `not_a_feed` fetch failure; anything else thrown is internal. */
  protected buildPosts(_feedId: string, body: string, criteria: MatchCriteria): CandidateStackPost[] {
    try {
      return toStackPosts(parseAlertFeed(body), criteria, this.clock.now())
    } catch (error) {
      if (error instanceof NotAFeedError) throw new AlertFeedError("not_a_feed")
      throw error
    }
  }

  private logInternal(name: string, error: unknown): void {
    this.logger.error(`${name} read failed: internal error ${safeErrorSummary(error)}`)
  }
}

/**
 * `{name} at {file}:{line}` for an internal error: the error's name and the
 * first stack frame in Eve's own code (`src/` under vitest, `dist/` in the
 * image), reduced to the file name. Never the message or the cause: a
 * database or fetch error can carry the feed URL (ADR 0012, CR-E5-03).
 */
export function safeErrorSummary(error: unknown): string {
  // The class name, not `error.name`: pg's DatabaseError sets `name` to the protocol message type ("error").
  const className = error instanceof Error ? error.constructor.name : ""
  const errorName = /^[\w$]{1,60}$/.test(className) ? className : "UnknownError"
  return `${errorName} at ${(error instanceof Error ? ownFrame(error) : null) ?? "unknown"}`
}

const OWN_FRAME = /[\\/](?:src|dist)[\\/](?:[\w.-]+[\\/])*([\w.-]+\.[cm]?[jt]s):(\d+)(?::\d+)?\)?$/

const V8_FRAME = /^ {4}at /

/**
 * SEC-E5F-03 (architecture r4 item 4): V8 formats `stack` as exactly
 * `Error.prototype.toString` of the error, a newline, then one line per frame,
 * even when the message or name spans several lines. So the frames are what
 * follows that header. When `stack` does not start with it (the message or name
 * changed after `stack` was first read, or the stack is not V8-shaped), or a
 * `name`/`message` getter throws, there is no frame: never guess where the
 * message ends. Only lines that start with four spaces and `at ` count.
 */
function ownFrame(error: Error): string | null {
  let header: string
  let stack: unknown
  try {
    header = Error.prototype.toString.call(error)
    stack = error.stack
  } catch {
    return null
  }
  if (typeof stack !== "string" || !stack.startsWith(`${header}\n`)) return null
  for (const frame of stack.slice(header.length + 1).split("\n")) {
    if (!V8_FRAME.test(frame) || frame.includes("node_modules")) continue
    const match = OWN_FRAME.exec(frame.trim())
    if (match) return `${match[1]}:${match[2]}`
  }
  return null
}
