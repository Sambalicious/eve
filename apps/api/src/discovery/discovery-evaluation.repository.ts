import { sql } from "../db/sql.js"

import type { HiddenReason } from "@eve/contracts"

import type { JobPostingStatus } from "../db/schema.js"
import type { CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { type VisibilityFacts, hiddenReason, visibilityContext, visibleSql } from "./visibility.js"
import { evaluationAllowed } from "./evaluation-allowed.js"
import { stuckSql } from "./stuck.js"
import { readPreferences } from "../preferences/preferences-read.js"
import { type PreferenceSkipReason, decidePreferenceSkip } from "./rules/preference-rules.js"

/** v1.28.1: a transient failure the worker retries once, and the minimum age before it does (migration 0036). */
export const RETRYABLE_FAILURES = ["not_configured", "provider_error", "invalid_output", "timed_out"] as const
export const RETRY_ATTEMPTS_LIMIT = 2
export const RETRY_BACKOFF_MINUTES = 10

/**
 * The evaluation lifecycle of one Candidate's postings, split out of
 * `DiscoveryRepository` (which delegates to this class, one instance per
 * facade): the visibility gate, the checking/waiting/failed transitions, the
 * queues the worker drains, Check again and the scheduled stuck recovery.
 *
 * Like the facade, every statement runs in the scope's `CandidateTx` (EPIC-0002 A1).
 */
export class DiscoveryEvaluationRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /** EPIC-0002 D13: whether the scope Candidate's postings may be evaluated now (the waiting reason of a paste). */
  evaluationAllowedNow(): Promise<boolean> {
    return this.tenant.run(async (tx, candidateId) => evaluationAllowed(await identityIn(tx, candidateId)))
  }

  /**
   * EPIC-0006 Check again (contract "POST /v1/job-postings/check-again"), one
   * transaction for the session Candidate: lock their Job criteria FOR SHARE,
   * claim every visible `evaluation_failed` or `not_checked` row, and (r4,
   * AC-7.13) every visible stuck `checking` row (`stuck.ts`), with
   * `UPDATE ... RETURNING` (the only dedupe; concurrent presses claim disjoint
   * rows), and, for the Operator only, insert one job per claimed row in the
   * same transaction. `evaluation_failure` is left as stored. Any failure
   * rolls back the claim and the jobs.
   */
  async checkAgain(now: Date, enqueue: (trx: CandidateTx, candidateId: string, ids: readonly string[]) => Promise<void>): Promise<{ queued: number; movedTo: "checking" | "waiting_to_be_checked" }> {
    return this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now, "share")
      const movedTo = evaluationAllowed(await identityIn(tx, candidateId)) ? "checking" : "waiting_to_be_checked"
      const claimed = await sql<{ id: string }>`
        update candidate_posting cp set status = ${movedTo}, checking_since = ${now}
        from job_posting p
        where cp.candidate_id = ${candidateId}::uuid and p.id = cp.job_posting_id
          and (cp.status in ('evaluation_failed', 'not_checked') or ${stuckSql("cp", now)}) and ${visibleSql("p", ctx)}
        returning cp.job_posting_id::text as id`.execute(tx)
      const ids = claimed.rows.map((row) => row.id)
      if (movedTo === "checking") await enqueue(tx, candidateId, ids)
      return { queued: ids.length, movedTo }
    })
  }

  /**
   * EPIC-0006 r4 (AC-7.14, AC-7.15, P19; architecture-stuck-checking.md): the
   * scheduled discovery run's recovery for the scope Candidate, in one
   * transaction. Their stuck rows that are hidden go back to the state AC-7.1
   * names (`evaluation_failed` with the stored kind, else `not_checked`), with
   * no job. Their visible stuck rows are claimed (`checking_since = now`, so
   * the 15 minutes restart) and returned for one evaluation job each. A
   * Candidate whose postings are not evaluated yet (D13) gets nothing claimed
   * or returned: only their own Check again recovers them.
   */
  async requeueStuck(now: Date): Promise<{ requeued: string[]; returnedHidden: number }> {
    return this.tenant.run(async (tx, candidateId) => {
      if (!evaluationAllowed(await identityIn(tx, candidateId))) return { requeued: [], returnedHidden: 0 }
      const ctx = await visibilityContext(tx, candidateId, now, "share")
      const hidden = await sql<{ id: string }>`
        update candidate_posting cp set status = case when cp.evaluation_failure is null then 'not_checked' else 'evaluation_failed' end
        from job_posting p
        where cp.candidate_id = ${candidateId}::uuid and p.id = cp.job_posting_id and ${stuckSql("cp", now)} and not ${visibleSql("p", ctx)}
        returning cp.job_posting_id::text as id`.execute(tx)
      const claimed = await sql<{ id: string }>`
        update candidate_posting cp set checking_since = ${now}
        from job_posting p
        where cp.candidate_id = ${candidateId}::uuid and p.id = cp.job_posting_id and ${stuckSql("cp", now)} and ${visibleSql("p", ctx)}
        returning cp.job_posting_id::text as id`.execute(tx)
      return { requeued: claimed.rows.map((row) => row.id), returnedHidden: hidden.rows.length }
    })
  }

  /**
   * Postings saved during a cost pause, oldest first (cost-ceiling.feature @r4).
   * EPIC-0006 (AC-7.1, AC-7.4): only the scope Candidate's visible ones; a
   * hidden waiting posting stays waiting.
   */
  async waitingIds(limit: number, now: Date): Promise<string[]> {
    const rows = await this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now)
      return tx
        .selectFrom("candidate_posting as cp")
        .innerJoin("job_posting as p", "p.id", "cp.job_posting_id")
        .select("cp.job_posting_id")
        .where("cp.candidate_id", "=", candidateId)
        .where("cp.status", "=", "waiting_to_be_checked")
        .where(visibleSql("p", ctx))
        .orderBy("cp.discovered_at")
        .orderBy("cp.job_posting_id")
        .limit(limit)
        .execute()
    })
    return rows.map((row) => row.job_posting_id)
  }

  /**
   * EPIC-0006 evaluator gate (AC-7.1): the posting's first hidden reason for
   * the scope Candidate, from their committed criteria (a plain read: a save in
   * progress does not block the gate; the verdict transaction serialises with
   * it as before, and AC-7.1 lets an in-flight call record its verdict).
   * When hidden, the row returns to the state the attempt found it in:
   * `checking` with a stored failure kind -> `evaluation_failed` (kind kept),
   * `checking` without one -> `not_checked`; `waiting_to_be_checked` and
   * `evaluation_failed` are left as they are. Undefined: the Candidate holds
   * no such posting.
   */
  async hideIfHidden(id: string, now: Date): Promise<HiddenReason | null | undefined> {
    return this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now)
      const row = await tx
        .selectFrom("job_posting as p")
        .innerJoin("candidate_posting as cp", (join) => join.onRef("cp.job_posting_id", "=", "p.id").on("cp.candidate_id", "=", candidateId))
        .select(["p.title_folded", "p.prefilter_skip", "p.role_family", "p.seniority_marker", "p.posted_at", "p.origin", "cp.status"])
        .where("p.id", "=", id)
        .forUpdate("cp")
        .executeTakeFirst()
      if (!row) return undefined
      const reason = hiddenReason(visibilityFactsOf(row), ctx)
      if (reason !== null && row.status === "checking") {
        await sql`update candidate_posting set status = case when evaluation_failure is null then 'not_checked' else 'evaluation_failed' end
          where candidate_id = ${candidateId}::uuid and job_posting_id = ${id}::uuid and status = 'checking'`.execute(tx)
      }
      return reason
    })
  }

  /**
   * EPIC-0006 (TM-05, CHK-38): when the scope Candidate may not have postings
   * evaluated yet, moves their `checking` row to `waiting_to_be_checked` and
   * returns true; the caller stops before any reservation.
   */
  async deferIfNotAllowed(id: string): Promise<boolean> {
    return this.tenant.run(async (tx, candidateId) => {
      if (evaluationAllowed(await identityIn(tx, candidateId))) return false
      await tx
        .updateTable("candidate_posting")
        .set({ status: "waiting_to_be_checked" })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "=", "checking")
        .execute()
      return true
    })
  }

  /**
   * Moves this Candidate's posting to "checking" from one of `from`; false when it is in any other state.
   * AC-7.12: restarts the 15 minutes (`checking_since = at`); the caller holds the evaluation lock.
   */
  async moveToChecking(id: string, from: readonly JobPostingStatus[], at: Date): Promise<boolean> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("candidate_posting")
        .set({ status: "checking", evaluation_failure: null, checking_since: at })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "in", from)
        .executeTakeFirst()
    )
    return Number(result.numUpdatedRows) > 0
  }

  async markFailed(id: string, failure: string, at: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("candidate_posting")
        .set({ status: "evaluation_failed", evaluation_failure: failure, evaluated_at: at, evaluation_attempts: sql<number>`evaluation_attempts + 1` })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .execute()
    )
  }

  /**
   * v1.28.1 automatic retry (migration 0036): visible postings whose evaluation failed once for a
   * transient reason, at least `RETRY_BACKOFF_MINUTES` ago, and that the worker has not already
   * retried. Oldest first. The row stays `evaluation_failed` until the retry claims it, so a lost
   * job is picked up by the next tick.
   */
  async retryFailedIds(limit: number, now: Date): Promise<string[]> {
    const rows = await this.tenant.run(async (tx, candidateId) => {
      const ctx = await visibilityContext(tx, candidateId, now, "share")
      return tx
        .selectFrom("candidate_posting as cp")
        .innerJoin("job_posting as p", "p.id", "cp.job_posting_id")
        .select("cp.job_posting_id")
        .where("cp.candidate_id", "=", candidateId)
        .where("cp.status", "=", "evaluation_failed")
        .where("cp.evaluation_attempts", "<", RETRY_ATTEMPTS_LIMIT)
        .where("cp.evaluation_failure", "in", [...RETRYABLE_FAILURES])
        .where("cp.evaluated_at", "is not", null)
        .where("cp.evaluated_at", "<=", new Date(now.getTime() - RETRY_BACKOFF_MINUTES * 60_000))
        .where(visibleSql("p", ctx))
        .orderBy("cp.evaluated_at")
        .orderBy("cp.job_posting_id")
        .limit(limit)
        .execute()
    })
    return rows.map((row) => row.job_posting_id)
  }

  async markWaiting(id: string): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx.updateTable("candidate_posting").set({ status: "waiting_to_be_checked" }).where("candidate_id", "=", candidateId).where("job_posting_id", "=", id).execute()
    )
  }

  /**
   * The evaluator's cost-pause step, before it claims the row: moves this Candidate's posting to
   * "waiting_to_be_checked" only from a state an evaluation may claim (the `moveToChecking` set). EPIC-0006 r4
   * (AC-7.16): a duplicate job (stuck re-queues send no singletonKey) for a posting that already has a verdict
   * changes nothing, even during the cost pause.
   */
  async markWaitingIfClaimable(id: string): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("candidate_posting")
        .set({ status: "waiting_to_be_checked" })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "in", ["checking", "waiting_to_be_checked", "evaluation_failed"])
        .execute()
    )
  }

  /**
   * EPIC-0002 B1 steps 2 and 3 before any paid work (R6-2: no AI call, no
   * reservation). Reads the current preferences and the posting's stored
   * family and folded title; when either rule skips, records `skipped` with
   * the reason, `skip_detail` null and `preferences_version`, and returns the
   * reason. Only a row this attempt holds in `checking` is written. Returns
   * null (writes nothing) when both rules pass or there is no record.
   */
  async skipByPreferences(id: string, at: Date): Promise<PreferenceSkipReason | null> {
    return this.tenant.run(async (trx, candidateId) => {
      const preferences = await readPreferences(trx, candidateId)
      if (preferences === null) return null
      const facts = await trx.selectFrom("job_posting").select(["role_family", "title_folded"]).where("id", "=", id).executeTakeFirst()
      if (!facts) return null
      const reason = decidePreferenceSkip(preferences.values, { roleFamily: facts.role_family, titleFolded: facts.title_folded })
      if (reason === null) return null
      const updated = await trx
        .updateTable("candidate_posting")
        .set({ status: "skipped", skip_reason: reason, skip_detail: null, evaluation_failure: null, evaluated_at: at, preferences_version: preferences.version })
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", id)
        .where("status", "=", "checking")
        .executeTakeFirst()
      return Number(updated.numUpdatedRows) > 0 ? reason : null
    })
  }
}

/** The visibility facts of a row read with POSTING_LIST_COLUMNS. Shared with `DiscoveryRepository`, which re-exports it. */
export function visibilityFactsOf(
  row: Readonly<{ title_folded: string | null; prefilter_skip: string | null; role_family: string | null; seniority_marker: string | null; posted_at: Date | null; origin: string }>
): VisibilityFacts {
  return {
    titled: row.title_folded !== null,
    prefilterSkip: row.prefilter_skip,
    roleFamily: row.role_family,
    seniorityMarker: row.seniority_marker,
    postedAt: row.posted_at,
    pastedDescription: row.origin === "pasted_description",
  }
}

/** Role and state of the scope Candidate, inside their transaction (the identity table has no RLS). Shared with `DiscoveryRepository`. */
export function identityIn(tx: CandidateTx, candidateId: string) {
  return tx.selectFrom("candidate").select(["role", "state"]).where("id", "=", candidateId).executeTakeFirst()
}
