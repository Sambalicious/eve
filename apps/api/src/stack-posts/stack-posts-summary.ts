import { Injectable } from "@nestjs/common"
import {
  type AlertFeedFailureReason,
  DEFAULT_JOB_CRITERIA,
  type HiringSearchGroup,
  type RoleFamilyValue,
  type StackSearchGroup,
  buildHiringSearchGroups,
  buildStackSearchGroups,
  hiringFamilies,
  maskAlertFeedUrl,
  roleFamilySchema,
} from "@eve/contracts"
import { sql } from "../db/sql.js"

import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { hiringHintsIn } from "./hiring-hints.js"
import { SUMMARY_WINDOW_LOCK_KEY } from "./stack-posts.repository.js"

/**
 * Architecture r4 item 3 (SEC-E5F-04): the window read waits at most 5 s for the exclusive lock, inside a
 * 10 s local statement bound (the worker default pair, `CLAIM_TIMEOUTS`), instead of the 60 s pool bound.
 * A timed-out wait throws; the sender records an `unknown` failed send and its backoff retries it.
 */
export const SUMMARY_READ_TIMEOUTS = transactionTimeouts(5_000, 10_000)

/** The most new posts the email lists; the rest are a count (AC 8.2). */
export const SUMMARY_POST_LIMIT = 10
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * EPIC-0007 Phase 1 (contract v1.19.0): the hiring links part. The first target
 * family with phrases in catalog order (D6) and its groups, or `family: null`
 * when no target family has phrases (AC 4.2).
 */
export type HiringLinksPart =
  | Readonly<{
      family: RoleFamilyValue
      groups: readonly HiringSearchGroup[]
      /** More than one target family has phrases: the email links to the Hiring view (C-HP-EMAIL-OTHER). */
      hasOtherFamilies: boolean
    }>
  | Readonly<{ family: null }>

/** Pure: the part for these saved values. The Hiring view calls the same builder with the same inputs (AC 3.1). */
export function hiringLinksPart(targets: readonly RoleFamilyValue[], frameworks: readonly string[], technologies: readonly string[], hintTerms: Parameters<typeof buildHiringSearchGroups>[0]["hintTerms"]): HiringLinksPart {
  const families = hiringFamilies(targets)
  const family = families[0]
  if (family === undefined) return { family: null }
  return { family, groups: buildHiringSearchGroups({ family, frameworks, technologies, hintTerms }), hasOtherFamilies: families.length > 1 }
}

/** Stored keys outside the current catalog are ignored rather than trusted. */
function storedTargets(stored: readonly string[] | undefined): RoleFamilyValue[] {
  if (stored === undefined) return [...DEFAULT_JOB_CRITERIA.targetRoleFamilies]
  return stored.flatMap((key) => {
    const parsed = roleFamilySchema.safeParse(key)
    return parsed.success ? [parsed.data] : []
  })
}

export type SummaryPost = Readonly<{ title: string; kind: "post" | "article"; canonicalUrl: string; date: Date; dateKind: "posted" | "found"; matchedTechnologies: readonly string[] }>
export type SummaryFailingFeed = Readonly<{ label: string | null; maskedUrl: string; reason: AlertFeedFailureReason }>

export type StackPostsSummary = Readonly<{
  groups: readonly StackSearchGroup[]
  /** EPIC-0007 Phase 1: built whether or not the verification exists (AC 4.1). */
  hiring: HiringLinksPart
  /** False: the posts and failures parts and the plain-text count are left out (AC 8.3). EPIC-0008: the summary Candidate's own Stack posts record; Stack posts only. */
  verified: boolean
  newPosts: readonly SummaryPost[]
  newCount: number
  failingFeeds: readonly SummaryFailingFeed[]
  /** EPIC-0007 Phase 3 (AC 9.1, 9.2, D14): the summary Candidate's own Hiring feed record exists. False leaves the Hiring posts part and count out. */
  hiringVerified: boolean
  /** Up to SUMMARY_POST_LIMIT, list order. [] when !hiringVerified. */
  hiringNewPosts: readonly SummaryPost[]
  hiringNewCount: number
  /** created_at, id order; masked. [] when !hiringVerified. */
  failingHiringFeeds: readonly SummaryFailingFeed[]
}>

type PostRow = { title: string; kind: "post" | "article"; canonical_url: string; published_at: Date | null; first_seen_at: Date; matched_technologies: string[] }

function toSummaryPost(row: PostRow): SummaryPost {
  return {
    title: row.title,
    kind: row.kind,
    canonicalUrl: row.canonical_url,
    date: row.published_at ?? row.first_seen_at,
    dateKind: row.published_at ? "posted" : "found",
    matchedTechnologies: row.matched_technologies,
  }
}

/**
 * The daily summary's view of Stack posts (architecture "Daily summary
 * integration"). Read-only. "New" (D-E5-3): first seen after the claim time
 * of the last `daily_summary` actually sent, up to this row's claim time;
 * with none ever sent, the 24 hours before this claim. No snippet is read
 * (D-E5-4); failing feeds carry the mask, never the URL (AC 7.4).
 *
 * EPIC-0002 A1: the scope's Candidate (the sender runs in it) only, in one
 * `CandidateTx`; every statement names `candidate_id`.
 *
 * The posts are read holding the window lock exclusively (F-QA-E5F-01,
 * architecture.r1.md "Revision r2"): no write can commit posts while this
 * read runs, and a write that stamped its posts before the read is waited
 * for, so a post is in exactly one window. The lock is transaction-scoped and
 * the whole read is one `CandidateTx`, so it is held until that commits.
 */
@Injectable()
export class StackPostsSummaryReader {
  constructor(private readonly tenant: TenantDatabase) {}

  summary(outboxId: string, claimedAt: Date): Promise<StackPostsSummary> {
    return this.tenant.run((db, candidateId) => this.read(db, candidateId, outboxId, claimedAt))
  }

  private async read(db: CandidateTx, candidateId: string, outboxId: string, claimedAt: Date): Promise<StackPostsSummary> {
    // SEC-E5F-04: bounds set first, so the window-lock wait below is bounded (the whole read is this one CandidateTx).
    await applyTransactionTimeouts(db, SUMMARY_READ_TIMEOUTS)
    const criteria = await db.selectFrom("job_criteria").select(["frameworks", "technologies", "target_role_families"]).where("candidate_id", "=", candidateId).executeTakeFirst()
    const groups = buildStackSearchGroups(criteria?.frameworks ?? [], criteria?.technologies ?? [])
    // EPIC-0007 Phase 1: same transaction, so the links reflect one consistent read (AC 3.8). An absent row uses the defaults.
    const hiring = hiringLinksPart(storedTargets(criteria?.target_role_families), criteria?.frameworks ?? [], criteria?.technologies ?? [], await hiringHintsIn(db, candidateId))
    // EPIC-0008 (AR-7, T8-9, CR-E8-01): the summary Candidate's own Stack posts record (alert_feed_candidate_verification); Stack posts
    // parts only. Existence only, like the Hiring line below: the summary never selects verification_basis.
    const verified = (await db.selectFrom("alert_feed_candidate_verification").select("candidate_id").where("candidate_id", "=", candidateId).executeTakeFirst()) !== undefined
    // EPIC-0007 Phase 3 (D14): the summary Candidate's own Hiring record; Hiring posts part only.
    const hiringVerified = (await db.selectFrom("hiring_feed_verification").select("candidate_id").where("candidate_id", "=", candidateId).executeTakeFirst()) !== undefined
    const empty = { newPosts: [], newCount: 0, failingFeeds: [], hiringNewPosts: [], hiringNewCount: 0, failingHiringFeeds: [] }
    if (!verified && !hiringVerified) return { groups, hiring, verified, hiringVerified, ...empty }

    const previous = await db
      .selectFrom("notification_outbox")
      .select("claimed_at")
      .where("candidate_id", "=", candidateId)
      .where("kind", "=", "daily_summary")
      .where("status", "=", "sent")
      .where("id", "!=", outboxId)
      .where("claimed_at", "is not", null)
      .where("claimed_at", "<", claimedAt)
      .orderBy("claimed_at", "desc")
      .limit(1)
      .executeTakeFirst()
    const lower = previous?.claimed_at ?? new Date(claimedAt.getTime() - DAY_MS)

    await sql`select pg_advisory_xact_lock(${SUMMARY_WINDOW_LOCK_KEY})`.execute(db)
    const stack = verified ? await this.windowRead(db, candidateId, "stack_post", "alert_feed", lower, claimedAt) : null
    const hiringPart = hiringVerified ? await this.windowRead(db, candidateId, "hiring_post", "hiring_alert_feed", lower, claimedAt) : null

    return {
      groups,
      hiring,
      verified,
      hiringVerified,
      newCount: stack?.count ?? 0,
      newPosts: stack?.posts ?? [],
      failingFeeds: stack?.failing ?? [],
      hiringNewCount: hiringPart?.count ?? 0,
      hiringNewPosts: hiringPart?.posts ?? [],
      failingHiringFeeds: hiringPart?.failing ?? [],
    }
  }

  /** New posts in the window and failing feeds of one list. Runs under the exclusive window lock. */
  private async windowRead(
    db: CandidateTx,
    candidateId: string,
    posts: "stack_post" | "hiring_post",
    feeds: "alert_feed" | "hiring_alert_feed",
    lower: Date,
    claimedAt: Date
  ): Promise<Readonly<{ count: number; posts: SummaryPost[]; failing: SummaryFailingFeed[] }>> {
    const window = db.selectFrom(posts).where("candidate_id", "=", candidateId).where("first_seen_at", ">", lower).where("first_seen_at", "<=", claimedAt)
    const { count } = await window.select((eb) => eb.fn.countAll<string>().as("count")).executeTakeFirstOrThrow()
    const rows = await window
      .select(["title", "kind", "canonical_url", "published_at", "first_seen_at", "matched_technologies"])
      .orderBy(sql`coalesce(published_at, first_seen_at)`, "desc")
      .orderBy("first_seen_at", "desc")
      .orderBy("id", "desc")
      .limit(SUMMARY_POST_LIMIT)
      .execute()
    const failing = await db
      .selectFrom(feeds)
      .select(["label", "url", "last_failure_reason"])
      .where("candidate_id", "=", candidateId)
      .where("last_failure_reason", "is not", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute()
    return {
      count: Number(count),
      posts: rows.map(toSummaryPost),
      failing: failing.map((row) => ({ label: row.label, maskedUrl: maskAlertFeedUrl(row.url), reason: row.last_failure_reason! })),
    }
  }
}
