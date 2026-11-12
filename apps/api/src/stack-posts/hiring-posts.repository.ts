import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import { HIRING_ALERT_FEED_LIMIT, STACK_POSTS_PAGE_SIZE } from "@eve/contracts"
import { sql } from "../db/sql.js"

import type { AlertFeedFailureCode, Database } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts } from "../db/transaction-timeouts.js"
import type { CandidateStackPost, MatchCriteria } from "./stack-post-builder.js"
import {
  type FeedRow,
  type FeedsState,
  globalPausedIn,
  REGISTER_FEED_TIMEOUTS,
  RETENTION_DAYS,
  RETENTION_MAX_POSTS,
  SUMMARY_WINDOW_LOCK_KEY,
  type StackPostRow,
  type VerificationRow,
  takeFeedRegistrationLock,
} from "./stack-posts.repository.js"

export type HiringInsertFeedResult =
  | Readonly<{ kind: "stored"; feed: FeedRow; storedPosts: number }>
  | Readonly<{ kind: "refused"; reason: "not_verified" | "limit_reached" | "duplicate" | "in_other_list" }>

export type HiringRunOutcome = "completed" | "skipped_global_pause" | "skipped_unverified"
export type HiringRunCounts = Readonly<{ feedsRead: number; feedsFailed: number; postsStored: number; postsDeleted: number }>

/**
 * EPIC-0007 Phase 3 (api-contract.r1.md, architecture.r2.md): data access for
 * Hiring Alert feeds and Hiring posts. The only writer of the four hiring tables,
 * `hiring_feed_verification` included (threat model P3-13).
 *
 * Every statement runs in the scope Candidate's `CandidateTx` (`tenant.run`)
 * under forced RLS and names `candidate_id` explicitly. The verification is
 * the scope Candidate's own row (D14). This class never reads
 * the shared EPIC-0005 record and never asks for a role (D15, P3-5).
 */
@Injectable()
export class HiringPostsRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** The scope Candidate's own Hiring feed verification, or null. */
  async verification(): Promise<VerificationRow | null> {
    return this.tenant.run((trx, candidateId) => ownHiringRecordIn(trx, candidateId))
  }

  /** Verification and feeds in one transaction (`GET hiring-feeds` consistency). */
  async feedsWithVerification(): Promise<FeedsState> {
    return this.tenant.run(async (trx, candidateId) => ({
      verification: await ownHiringRecordIn(trx, candidateId),
      feeds: await feedsIn(trx, candidateId),
      globalPaused: await globalPausedIn(trx),
    }))
  }

  /**
   * AC 6.6 (P3-13): upsert of the scope Candidate's own row; the last
   * successful save wins. The id comes from the scope only, `updated_at` is
   * the server's clock, and the saved record and feeds are read back in the
   * same transaction.
   */
  async saveVerification(verifiedOn: string, basis: string, at: Date): Promise<FeedsState> {
    return this.tenant.run(async (trx, candidateId) => {
      await trx
        .insertInto("hiring_feed_verification")
        .values({ candidate_id: candidateId, verified_on: verifiedOn, verification_basis: basis, updated_at: at })
        .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ verified_on: verifiedOn, verification_basis: basis, updated_at: at }))
        .execute()
      return { verification: await ownHiringRecordIn(trx, candidateId), feeds: await feedsIn(trx, candidateId), globalPaused: await globalPausedIn(trx) }
    })
  }

  async feeds(): Promise<FeedRow[]> {
    return this.tenant.run((trx, candidateId) => feedsIn(trx, candidateId))
  }

  async feedCount(): Promise<number> {
    return this.tenant.run((trx, candidateId) => hiringFeedCount(trx, candidateId))
  }

  async feedUrlExists(url: string): Promise<boolean> {
    return this.tenant.run((trx, candidateId) => hiringFeedUrlExists(trx, candidateId, url))
  }

  /** The trimmed URL is one of the caller's Stack posts Alert feeds (`url/in_other_list`). */
  async feedUrlInStackList(url: string): Promise<boolean> {
    return this.tenant.run((trx, candidateId) => stackFeedUrlExists(trx, candidateId, url))
  }

  async feedExists(id: string): Promise<boolean> {
    const row = await this.tenant.run((trx, candidateId) =>
      trx.selectFrom("hiring_alert_feed").select("id").where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirst()
    )
    return row !== undefined
  }

  async criteria(): Promise<MatchCriteria> {
    const row = await this.tenant.run((trx, candidateId) =>
      trx.selectFrom("job_criteria").select(["frameworks", "technologies"]).where("candidate_id", "=", candidateId).executeTakeFirst()
    )
    return { frameworks: row?.frameworks ?? [], technologies: row?.technologies ?? [] }
  }

  async globalPaused(): Promise<boolean> {
    return this.tenant.run((trx) => globalPausedIn(trx))
  }

  /**
   * Registration step 9 (api-contract.r1.md): timeouts, then the per-Candidate
   * registration lock (the first lock, P3-4), then the re-checks in check order:
   * own verification, limit, duplicate, in_other_list. Feed and posts are
   * written in the same transaction; `first_seen_at` settles under the shared
   * summary window lock. The verification read is plain: no route deletes it.
   */
  async insertFeedWithPosts(url: string, label: string | null, posts: readonly CandidateStackPost[], at: Date): Promise<HiringInsertFeedResult> {
    return this.tenant.run(async (trx, candidateId) => {
      await applyTransactionTimeouts(trx, REGISTER_FEED_TIMEOUTS)
      await takeFeedRegistrationLock(trx, candidateId)
      if (!(await ownHiringRecordIn(trx, candidateId))) return { kind: "refused", reason: "not_verified" } as const
      if ((await hiringFeedCount(trx, candidateId)) >= HIRING_ALERT_FEED_LIMIT) return { kind: "refused", reason: "limit_reached" } as const
      if (await hiringFeedUrlExists(trx, candidateId, url)) return { kind: "refused", reason: "duplicate" } as const
      if (await stackFeedUrlExists(trx, candidateId, url)) return { kind: "refused", reason: "in_other_list" } as const
      const row = await trx
        .insertInto("hiring_alert_feed")
        .values({ candidate_id: candidateId, id: randomUUID(), url, label, created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null })
        .returningAll()
        .executeTakeFirstOrThrow()
      const inserted = await insertHiringPosts(trx, candidateId, posts, row.id, at)
      await settleHiringFirstSeen(trx, candidateId, inserted)
      return { kind: "stored", feed: toFeedRow(row), storedPosts: inserted.length } as const
    })
  }

  /** Hard delete of the caller's row; posts keep `source_feed_id = null`. Unknown or foreign ids change nothing. */
  async deleteFeed(id: string): Promise<void> {
    await this.tenant.run((trx, candidateId) => trx.deleteFrom("hiring_alert_feed").where("candidate_id", "=", candidateId).where("id", "=", id).execute())
  }

  /** A successful scheduled read. Discards everything when the feed was removed meanwhile. */
  async recordRead(feedId: string, posts: readonly CandidateStackPost[], at: Date): Promise<number | null> {
    return this.tenant.run(async (trx, candidateId) => {
      const feed = await trx.selectFrom("hiring_alert_feed").select("id").where("candidate_id", "=", candidateId).where("id", "=", feedId).forShare().executeTakeFirst()
      if (!feed) return null
      const inserted = await insertHiringPosts(trx, candidateId, posts, feedId, at)
      await trx
        .updateTable("hiring_alert_feed")
        .set({ last_read_at: at, last_failure_reason: null, last_failed_at: null })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", feedId)
        .execute()
      await settleHiringFirstSeen(trx, candidateId, inserted)
      return inserted.length
    })
  }

  /** A failed scheduled read; `last_read_at` is kept. A no-op when the feed was removed. */
  async recordFailure(feedId: string, reason: AlertFeedFailureCode, at: Date): Promise<void> {
    await this.tenant.run((trx, candidateId) =>
      trx.updateTable("hiring_alert_feed").set({ last_failure_reason: reason, last_failed_at: at }).where("candidate_id", "=", candidateId).where("id", "=", feedId).execute()
    )
  }

  /** AC 7.3, per Candidate: age first, then the count cap, by first-seen time; run rows older than 90 days. Never touches `stack_post`. */
  async applyRetention(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    return this.tenant.run(async (trx, candidateId) => {
      const aged = await trx.deleteFrom("hiring_post").where("candidate_id", "=", candidateId).where("first_seen_at", "<", cutoff).executeTakeFirst()
      const capped = await sql`
        delete from hiring_post where candidate_id = ${candidateId} and id in (
          select id from hiring_post where candidate_id = ${candidateId} order by first_seen_at desc, id desc offset ${RETENTION_MAX_POSTS}
        )`.execute(trx)
      await trx.deleteFrom("hiring_post_run").where("candidate_id", "=", candidateId).where("started_at", "<", cutoff).execute()
      return Number(aged.numDeletedRows) + Number(capped.numAffectedRows ?? 0n)
    })
  }

  async startRun(at: Date): Promise<string> {
    const id = randomUUID()
    await this.tenant.run((trx, candidateId) =>
      trx.insertInto("hiring_post_run").values({ candidate_id: candidateId, id, started_at: at, finished_at: null, outcome: "running" }).execute()
    )
    return id
  }

  async finishRun(id: string, at: Date, outcome: HiringRunOutcome, counts: HiringRunCounts = { feedsRead: 0, feedsFailed: 0, postsStored: 0, postsDeleted: 0 }): Promise<void> {
    await this.tenant.run((trx, candidateId) =>
      trx
        .updateTable("hiring_post_run")
        .set({ finished_at: at, outcome, feeds_read: counts.feedsRead, feeds_failed: counts.feedsFailed, posts_stored: counts.postsStored, posts_deleted: counts.postsDeleted })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    )
  }

  /** One page in one statement (AC 7.4): coalesce(published, first seen) desc, first seen desc, id desc; totals from the same snapshot. */
  async page(page: number): Promise<{ rows: StackPostRow[]; totalCount: number }> {
    const { rows } = await this.tenant.run((trx, candidateId) => sql<{
      id: string
      canonical_url: string
      kind: "post" | "article"
      title: string
      snippet: string
      published_at: Date | null
      matched_technologies: string[]
      first_seen_at: Date
      source_feed_id: string | null
      label: string | null
      url: string | null
      total: string
    }>`
      with counted as (select count(*) as total from hiring_post where candidate_id = ${candidateId})
      select p.id, p.canonical_url, p.kind, p.title, p.snippet, p.published_at, p.matched_technologies,
             p.first_seen_at, p.source_feed_id, f.label, f.url, counted.total
      from counted
      left join lateral (
        select * from hiring_post
        where candidate_id = ${candidateId}
        order by coalesce(published_at, first_seen_at) desc, first_seen_at desc, id desc
        offset ${(page - 1) * STACK_POSTS_PAGE_SIZE} limit ${STACK_POSTS_PAGE_SIZE}
      ) p on true
      left join hiring_alert_feed f on f.candidate_id = ${candidateId} and f.id = p.source_feed_id
      order by coalesce(p.published_at, p.first_seen_at) desc, p.first_seen_at desc, p.id desc`.execute(trx))
    const totalCount = Number(rows[0]?.total ?? 0)
    return {
      totalCount,
      rows: rows
        .filter((row) => row.id !== null)
        .map((row) => ({
          id: row.id,
          canonicalUrl: row.canonical_url,
          kind: row.kind,
          title: row.title,
          snippet: row.snippet,
          publishedAt: row.published_at,
          matchedTechnologies: row.matched_technologies,
          firstSeenAt: row.first_seen_at,
          sourceFeedId: row.source_feed_id,
          sourceLabel: row.label,
          sourceUrl: row.url,
        })),
    }
  }
}

/** The Candidate's own Hiring feed verification (D14): explicit `candidate_id` filter inside the passed `CandidateTx` (P3-5e). */
export async function ownHiringRecordIn(trx: CandidateTx, candidateId: string): Promise<VerificationRow | null> {
  const row = await trx
    .selectFrom("hiring_feed_verification")
    .select([sql<string>`verified_on::text`.as("verified_on"), "verification_basis", "updated_at"])
    .where("candidate_id", "=", candidateId)
    .executeTakeFirst()
  return row ? { verifiedOn: row.verified_on, verificationBasis: row.verification_basis, updatedAt: row.updated_at } : null
}

async function feedsIn(trx: CandidateTx, candidateId: string): Promise<FeedRow[]> {
  const rows = await trx.selectFrom("hiring_alert_feed").selectAll().where("candidate_id", "=", candidateId).orderBy("created_at").orderBy("id").execute()
  return rows.map(toFeedRow)
}

async function hiringFeedCount(trx: CandidateTx, candidateId: string): Promise<number> {
  const { count } = await trx.selectFrom("hiring_alert_feed").select((eb) => eb.fn.countAll<string>().as("count")).where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()
  return Number(count)
}

async function hiringFeedUrlExists(trx: CandidateTx, candidateId: string, url: string): Promise<boolean> {
  return (await trx.selectFrom("hiring_alert_feed").select("id").where("candidate_id", "=", candidateId).where("url", "=", url).executeTakeFirst()) !== undefined
}

async function stackFeedUrlExists(trx: CandidateTx, candidateId: string, url: string): Promise<boolean> {
  return (await trx.selectFrom("alert_feed").select("id").where("candidate_id", "=", candidateId).where("url", "=", url).executeTakeFirst()) !== undefined
}

function toFeedRow(row: Database["hiring_alert_feed"]): FeedRow {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    createdAt: row.created_at,
    lastReadAt: row.last_read_at,
    failureReason: row.last_failure_reason,
    failedAt: row.last_failed_at,
  }
}

/** `on conflict (candidate_id, canonical_url) do nothing` keeps the first source and the original matches (AC 7.1, 7.2). */
async function insertHiringPosts(trx: CandidateTx, candidateId: string, posts: readonly CandidateStackPost[], feedId: string, at: Date): Promise<string[]> {
  if (posts.length === 0) return []
  const rows = await trx
    .insertInto("hiring_post")
    .values(
      posts.map((post) => ({
        candidate_id: candidateId,
        id: randomUUID(),
        canonical_url: post.canonicalUrl,
        kind: post.kind,
        title: post.title,
        snippet: post.snippet,
        published_at: post.publishedAt,
        matched_technologies: [...post.matchedTechnologies],
        source_feed_id: feedId,
        first_seen_at: at,
      }))
    )
    .onConflict((oc) => oc.columns(["candidate_id", "canonical_url"]).doNothing())
    .returning("id")
    .execute()
  return rows.map((row) => row.id)
}

/**
 * As `settleFirstSeen` in the Stack posts repository (F-QA-E5F-01): the window
 * lock held shared, then `first_seen_at` raised past the latest summary claim,
 * so each Hiring post lands in exactly one daily summary.
 */
async function settleHiringFirstSeen(trx: CandidateTx, candidateId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await sql`select pg_advisory_xact_lock_shared(${SUMMARY_WINDOW_LOCK_KEY})`.execute(trx)
  await sql`update hiring_post
    set first_seen_at = greatest(
      first_seen_at,
      (select max(claimed_at) from notification_outbox where candidate_id = ${candidateId} and kind = 'daily_summary') + interval '1 millisecond'
    )
    where candidate_id = ${candidateId} and id = any(${[...ids]}::uuid[])`.execute(trx)
}
