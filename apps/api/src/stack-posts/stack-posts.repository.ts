import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import { ALERT_FEED_LIMIT, type HiringHintTerm, STACK_POSTS_PAGE_SIZE } from "@eve/contracts"
import { sql } from "../db/sql.js"

import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import type { AlertFeedFailureCode, Database } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { hiringHintsIn } from "./hiring-hints.js"
import type { CandidateStackPost, MatchCriteria } from "./stack-post-builder.js"

export type VerificationRow = Readonly<{ verifiedOn: string; verificationBasis: string; updatedAt: Date }>

export type FeedRow = Readonly<{
  id: string
  url: string
  label: string | null
  createdAt: Date
  lastReadAt: Date | null
  failureReason: AlertFeedFailureCode | null
  failedAt: Date | null
}>

/** A feeds response's data, read in one `CandidateTx`. `globalPaused` is the shared pause flag (OWN-1). */
export type FeedsState = Readonly<{ verification: VerificationRow | null; feeds: FeedRow[]; globalPaused: boolean }>

export type StackPostRow = Readonly<{
  id: string
  canonicalUrl: string
  kind: "post" | "article"
  title: string
  snippet: string
  publishedAt: Date | null
  matchedTechnologies: string[]
  firstSeenAt: Date
  sourceLabel: string | null
  sourceUrl: string | null
  sourceFeedId: string | null
}>

export type InsertFeedResult =
  | Readonly<{ kind: "stored"; feed: FeedRow; storedPosts: number }>
  | Readonly<{ kind: "refused"; reason: "not_verified" | "limit_reached" | "duplicate" | "in_other_list" }>

/** AC 5.8: posts first seen more than 90 days before the run are deleted, then all but the newest 2,000. */
export const RETENTION_DAYS = 90
export const RETENTION_MAX_POSTS = 2000

/**
 * F-QA-E5F-01 (architecture.r1.md "Revision r2"): the advisory lock that orders
 * a write's final `first_seen_at` against the daily summary's read of posts.
 * Writers hold it shared from their last statement to commit; the summary holds
 * it exclusively while it reads. Transaction-scoped, so it can never leak.
 * One installation-wide key: it serialises summaries of different Candidates
 * too, which is safe and cheap at this scale.
 */
export const SUMMARY_WINDOW_LOCK_KEY = 72_005_100

/**
 * Architecture r4 item 3 (SEC-E5F-04, CR-E5F-03): registration waits at most 3 s for the per-Candidate
 * registration lock and the summary-window lock (EPIC-0008 AR-4: no row lock on the verification), inside a 10 s local statement bound (the `SAVE_TIMEOUTS` pair). The lock bound
 * is shorter than the api pool's 5 s statement bound, so a timed-out wait ends with 55P03, which the service
 * maps to a retryable 503.
 */
export const REGISTER_FEED_TIMEOUTS = transactionTimeouts(3_000, 10_000)

/**
 * EPIC-0007 Phase 3 (api-contract.r1.md, threat model P3-4): the class of the
 * per-Candidate registration lock, `pg_advisory_xact_lock(class, hashtext(candidate_id))`.
 * Both registration routes (Stack posts and Hiring) take it first, after the
 * timeouts, so for one Candidate the cross-list, duplicate and limit re-checks
 * run one at a time. Transaction-scoped; the two-key form cannot collide with
 * the single-key SUMMARY_WINDOW_LOCK_KEY. Registrations of different Candidates
 * wait for each other only on a `hashtext` collision, which never changes a result.
 */
export const FEED_REGISTRATION_LOCK_CLASS = 72_007_001

/** The first lock in every feed registration transaction. The id is the scope's (`tenant.run`), never the request's. */
export async function takeFeedRegistrationLock(trx: CandidateTx, candidateId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(${FEED_REGISTRATION_LOCK_CLASS}::int, hashtext(${candidateId}::text))`.execute(trx)
}

/**
 * Data access for the Stack posts module. The only writer of its four tables.
 *
 * EPIC-0002 A1: `alert_feed`, `stack_post` and `stack_post_run` are Candidate
 * data (migration 0016). Every statement runs in the scope's `CandidateTx` and
 * names its `candidate_id`; RLS backs that up. EPIC-0008 (AR-1): the
 * permitted-use record is Candidate data too, the scope Candidate's own row
 * in `alert_feed_candidate_verification`. `control_state` (the global pause)
 * is the only shared read. No method asks for a role.
 */
@Injectable()
export class StackPostsRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** EPIC-0007 Phase 1: the scope Candidate's hiring hint terms, in one `CandidateTx`. Reads only. */
  async hiringHints(): Promise<HiringHintTerm[]> {
    return this.tenant.run((trx, candidateId) => hiringHintsIn(trx, candidateId))
  }

  /** EPIC-0008: the scope Candidate's own Stack posts feed verification, or null. */
  async verification(): Promise<VerificationRow | null> {
    return this.tenant.run((trx, candidateId) => ownStackRecordIn(trx, candidateId))
  }

  /** Verification and feeds in one transaction (`GET alert-feeds` consistency, v1.22.0). */
  async feedsWithVerification(): Promise<FeedsState> {
    return this.tenant.run(async (trx, candidateId) => ({
      verification: await ownStackRecordIn(trx, candidateId),
      feeds: await feedsIn(trx, candidateId),
      globalPaused: await globalPausedIn(trx),
    }))
  }

  /**
   * v1.22.0 (EPIC-0008, AR-3): upsert of the scope Candidate's own row; the
   * last successful save wins (AC 1.3). Any Candidate; no role check. The id
   * comes from the scope only, `updated_at` is the server's clock, and the
   * saved record and feeds are read back in the same transaction.
   */
  async saveVerification(verifiedOn: string, basis: string, at: Date): Promise<FeedsState> {
    return this.tenant.run(async (trx, candidateId) => {
      await trx
        .insertInto("alert_feed_candidate_verification")
        .values({ candidate_id: candidateId, verified_on: verifiedOn, verification_basis: basis, updated_at: at })
        .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ verified_on: verifiedOn, verification_basis: basis, updated_at: at }))
        .execute()
      return { verification: await ownStackRecordIn(trx, candidateId), feeds: await feedsIn(trx, candidateId), globalPaused: await globalPausedIn(trx) }
    })
  }

  async feeds(): Promise<FeedRow[]> {
    return this.tenant.run((trx, candidateId) => feedsIn(trx, candidateId))
  }

  async feedCount(): Promise<number> {
    const { count } = await this.tenant.run((trx, candidateId) =>
      trx.selectFrom("alert_feed").select((eb) => eb.fn.countAll<string>().as("count")).where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()
    )
    return Number(count)
  }

  async feedUrlExists(url: string): Promise<boolean> {
    const row = await this.tenant.run((trx, candidateId) =>
      trx.selectFrom("alert_feed").select("id").where("candidate_id", "=", candidateId).where("url", "=", url).executeTakeFirst()
    )
    return row !== undefined
  }

  /** EPIC-0007 Phase 3: the trimmed URL is one of the caller's Hiring Alert feeds (`url/in_other_list`). */
  async feedUrlInHiringList(url: string): Promise<boolean> {
    const row = await this.tenant.run((trx, candidateId) =>
      trx.selectFrom("hiring_alert_feed").select("id").where("candidate_id", "=", candidateId).where("url", "=", url).executeTakeFirst()
    )
    return row !== undefined
  }

  async feedExists(id: string): Promise<boolean> {
    const row = await this.tenant.run((trx, candidateId) =>
      trx.selectFrom("alert_feed").select("id").where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirst()
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
   * Registration step 9 (api-contract.md v1.22.0): timeouts, then the
   * per-Candidate registration lock (the only lock before the summary window
   * lock, AR-4), then the re-checks in check order: own record, limit,
   * duplicate, in_other_list. The feed and its posts are written in one
   * transaction. The record read is plain (no FOR UPDATE): no route deletes a
   * record, so a row seen here cannot vanish before commit. A future delete
   * route must take the same advisory lock.
   */
  async insertFeedWithPosts(url: string, label: string | null, posts: readonly CandidateStackPost[], at: Date): Promise<InsertFeedResult> {
    return this.tenant.run(async (trx, candidateId) => {
      await applyTransactionTimeouts(trx, REGISTER_FEED_TIMEOUTS)
      await takeFeedRegistrationLock(trx, candidateId)
      if (!(await ownStackRecordIn(trx, candidateId))) return { kind: "refused", reason: "not_verified" } as const
      const { count } = await trx.selectFrom("alert_feed").select((eb) => eb.fn.countAll<string>().as("count")).where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()
      if (Number(count) >= ALERT_FEED_LIMIT) return { kind: "refused", reason: "limit_reached" } as const
      if (await trx.selectFrom("alert_feed").select("id").where("candidate_id", "=", candidateId).where("url", "=", url).executeTakeFirst()) return { kind: "refused", reason: "duplicate" } as const
      if (await trx.selectFrom("hiring_alert_feed").select("id").where("candidate_id", "=", candidateId).where("url", "=", url).executeTakeFirst()) return { kind: "refused", reason: "in_other_list" } as const
      const row = await trx
        .insertInto("alert_feed")
        .values({ candidate_id: candidateId, id: randomUUID(), url, label, created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null })
        .returningAll()
        .executeTakeFirstOrThrow()
      const inserted = await insertPosts(trx, candidateId, posts, row.id, at)
      await settleFirstSeen(trx, candidateId, inserted)
      return { kind: "stored", feed: toFeedRow(row), storedPosts: inserted.length } as const
    })
  }

  /** Hard delete (architecture "Removed feeds"); posts keep `source_feed_id = null`. Idempotent. */
  async deleteFeed(id: string): Promise<void> {
    await this.tenant.run((trx, candidateId) => trx.deleteFrom("alert_feed").where("candidate_id", "=", candidateId).where("id", "=", id).execute())
  }

  /** A successful scheduled read. Discards everything when the feed was removed meanwhile (AC 4.8). */
  async recordRead(feedId: string, posts: readonly CandidateStackPost[], at: Date): Promise<number | null> {
    return this.tenant.run(async (trx, candidateId) => {
      const feed = await trx.selectFrom("alert_feed").select("id").where("candidate_id", "=", candidateId).where("id", "=", feedId).forShare().executeTakeFirst()
      if (!feed) return null
      const inserted = await insertPosts(trx, candidateId, posts, feedId, at)
      await trx
        .updateTable("alert_feed")
        .set({ last_read_at: at, last_failure_reason: null, last_failed_at: null })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", feedId)
        .execute()
      await settleFirstSeen(trx, candidateId, inserted)
      return inserted.length
    })
  }

  /** A failed scheduled read; `last_read_at` is kept. A no-op when the feed was removed. */
  async recordFailure(feedId: string, reason: AlertFeedFailureCode, at: Date): Promise<void> {
    await this.tenant.run((trx, candidateId) =>
      trx.updateTable("alert_feed").set({ last_failure_reason: reason, last_failed_at: at }).where("candidate_id", "=", candidateId).where("id", "=", feedId).execute()
    )
  }

  /** AC 5.8, per Candidate: age first, then the count cap, by first-seen time. Also prunes run rows older than 90 days. */
  async applyRetention(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    return this.tenant.run(async (trx, candidateId) => {
      const aged = await trx.deleteFrom("stack_post").where("candidate_id", "=", candidateId).where("first_seen_at", "<", cutoff).executeTakeFirst()
      const capped = await sql`
        delete from stack_post where candidate_id = ${candidateId} and id in (
          select id from stack_post where candidate_id = ${candidateId} order by first_seen_at desc, id desc offset ${RETENTION_MAX_POSTS}
        )`.execute(trx)
      await trx.deleteFrom("stack_post_run").where("candidate_id", "=", candidateId).where("started_at", "<", cutoff).execute()
      return Number(aged.numDeletedRows) + Number(capped.numAffectedRows ?? 0n)
    })
  }

  async startRun(at: Date): Promise<string> {
    const id = randomUUID()
    await this.tenant.run((trx, candidateId) =>
      trx.insertInto("stack_post_run").values({ candidate_id: candidateId, id, started_at: at, finished_at: null, outcome: "running" }).execute()
    )
    return id
  }

  async finishRun(
    id: string,
    at: Date,
    outcome: "completed" | "skipped_global_pause" | "skipped_unverified",
    counts: Readonly<{ feedsRead: number; feedsFailed: number; postsStored: number; postsDeleted: number }> = { feedsRead: 0, feedsFailed: 0, postsStored: 0, postsDeleted: 0 }
  ): Promise<void> {
    await this.tenant.run((trx, candidateId) =>
      trx
        .updateTable("stack_post_run")
        .set({ finished_at: at, outcome, feeds_read: counts.feedsRead, feeds_failed: counts.feedsFailed, posts_stored: counts.postsStored, posts_deleted: counts.postsDeleted })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    )
  }

  /**
   * One page in one statement (AC 7.1): order coalesce(published, first seen)
   * desc, first seen desc, id desc; totals from the same snapshot.
   */
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
      with counted as (select count(*) as total from stack_post where candidate_id = ${candidateId})
      select p.id, p.canonical_url, p.kind, p.title, p.snippet, p.published_at, p.matched_technologies,
             p.first_seen_at, p.source_feed_id, f.label, f.url, counted.total
      from counted
      left join lateral (
        select * from stack_post
        where candidate_id = ${candidateId}
        order by coalesce(published_at, first_seen_at) desc, first_seen_at desc, id desc
        offset ${(page - 1) * STACK_POSTS_PAGE_SIZE} limit ${STACK_POSTS_PAGE_SIZE}
      ) p on true
      left join alert_feed f on f.candidate_id = ${candidateId} and f.id = p.source_feed_id
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

/**
 * The global pause flag (`control_state.global_paused`, the shared singleton
 * `GET /v1/controls` also reads), from inside a Candidate's transaction. The
 * flag only: no time, cost pause or spend (OWN-1). False when the row is missing.
 */
export async function globalPausedIn(trx: CandidateTx): Promise<boolean> {
  const row = await trx.selectFrom("control_state").select("global_paused").executeTakeFirst()
  return row?.global_paused ?? false
}

/** The caller's own Stack posts record, or null (v1.22.0). Always filters by candidate_id explicitly; RLS backs it up. */
export async function ownStackRecordIn(trx: CandidateTx, candidateId: string): Promise<VerificationRow | null> {
  const row = await trx
    .selectFrom("alert_feed_candidate_verification")
    .select([sql<string>`verified_on::text`.as("verified_on"), "verification_basis", "updated_at"])
    .where("candidate_id", "=", candidateId)
    .executeTakeFirst()
  return row ? { verifiedOn: row.verified_on, verificationBasis: row.verification_basis, updatedAt: row.updated_at } : null
}

async function feedsIn(trx: CandidateTx, candidateId: string): Promise<FeedRow[]> {
  const rows = await trx.selectFrom("alert_feed").selectAll().where("candidate_id", "=", candidateId).orderBy("created_at").orderBy("id").execute()
  return rows.map(toFeedRow)
}

function toFeedRow(row: Database["alert_feed"]): FeedRow {
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

/**
 * `on conflict (candidate_id, canonical_url) do nothing` keeps the first source and the original matches (AC 5.3, 5.6).
 * Returns the ids of the rows this call inserted.
 */
async function insertPosts(trx: CandidateTx, candidateId: string, posts: readonly CandidateStackPost[], feedId: string, at: Date): Promise<string[]> {
  if (posts.length === 0) return []
  const rows = await trx
    .insertInto("stack_post")
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
 * The last statements of every transaction that stores posts (F-QA-E5F-01,
 * architecture.r1.md "Revision r2"). A post must be in exactly one daily
 * summary (AC 8.2), but its time was taken before the transaction commits,
 * and a summary that claims in between cannot see it yet.
 *
 * 1. Take the window lock shared. This waits for a summary that is reading
 *    posts now, and makes any summary that starts reading later wait for this
 *    commit. It is its own statement so that step 2's snapshot is taken after
 *    the lock is held.
 * 2. Raise `first_seen_at` to just past the Candidate's latest `daily_summary`
 *    claim. A summary that claimed before this point either already read (it
 *    could not see the row, and the post moves to the next window) or reads
 *    after this commit (it sees the row, outside its window, and the next one
 *    lists it). A summary that claims after this point waits for the commit
 *    and lists it.
 *
 * 1 ms, not 1 µs: claim times are read back into a millisecond `Date`.
 */
async function settleFirstSeen(trx: CandidateTx, candidateId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await sql`select pg_advisory_xact_lock_shared(${SUMMARY_WINDOW_LOCK_KEY})`.execute(trx)
  await sql`update stack_post
    set first_seen_at = greatest(
      first_seen_at,
      (select max(claimed_at) from notification_outbox where candidate_id = ${candidateId} and kind = 'daily_summary') + interval '1 millisecond'
    )
    where candidate_id = ${candidateId} and id = any(${[...ids]}::uuid[])`.execute(trx)
}
