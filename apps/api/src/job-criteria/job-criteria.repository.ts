import { Injectable } from "@nestjs/common"
import type { JobCriteriaRequest } from "@eve/contracts"
import { sql } from "../db/sql.js"

import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { type StoredJobCriteria, criteriaOf, criteriaRow } from "../discovery/discovery.repository.js"
import { canonicalEntries, decisionCriteria } from "../discovery/rules/job-criteria.js"
import { sharePreferences } from "../preferences/preferences-lock.js"
import { stepsTwoAndThree } from "../preferences/redecide.js"
import { type ChangedDecision, type StoredDecision, isRedecidable, redecide } from "./redecide.js"

export type SaveResult = Readonly<{
  criteria: StoredJobCriteria
  /** False when minimum, frameworks and technologies were unchanged: no EPIC-0004 re-decision ran (EPIC-0006 AC-4.2). */
  redecided: boolean
  considered: number
  changed: readonly ChangedDecision[]
}>

/** Architecture "Save and re-decision": bounds a save waiting on an evaluation, and a stuck save. */
export const SAVE_TIMEOUTS = transactionTimeouts(3_000, 10_000)

type DecisionRow = {
  id: string
  status: string
  skip_reason: string | null
  role_family: string | null
  title_folded: string | null
  verdict: string
  covered_count: number
  total_count: number
  /** String names only (SEC-008): entries that are not objects with a string name are left out in SQL. */
  names: string[] | null
}

/**
 * EPIC-0002 A1: every statement runs in the scope's `CandidateTx`; the
 * Candidate's `job_criteria` row and `match_evidence` name `candidate_id`.
 * The re-decision reads and writes the Candidate's own `candidate_posting`
 * rows (item 6), so one Candidate's save never changes another's status.
 */
@Injectable()
export class JobCriteriaRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  async read(): Promise<StoredJobCriteria> {
    return criteriaOf(await this.tenant.run((tx, candidateId) => criteriaRow(tx, candidateId).executeTakeFirstOrThrow()))
  }

  /**
   * One transaction (AC 5.5): lock the criteria row FOR UPDATE, store the new
   * values with version + 1, re-decide every ranked or skipped posting with
   * Match evidence from stored counts and names (malformed entries ignored,
   * SEC-008), write only the changed rows,
   * then stamp threshold, criteria version and canonical entries on every
   * ranked or skipped posting's evidence. Any failure rolls all of it back.
   * EPIC-0006 (AC-4.1, AC-4.2): when the minimum and both lists are unchanged
   * (a families- or floor-only save), the re-decision is skipped and only the
   * Match evidence is restamped with the new version.
   * Never touches an Application, AI call or spend row (AC 5.3, 5.8).
   */
  saveAndRedecide(request: JobCriteriaRequest): Promise<SaveResult> {
    return this.tenant.run((trx, candidateId) => this.saveIn(trx, candidateId, request))
  }

  /**
   * The save's statements in the caller's transaction (B1 unit 7: the race
   * tests hold it open). EPIC-0002 B1 "Job criteria save rule": the
   * Candidate's Job Preferences row FOR SHARE first (the lock order), then
   * `job_criteria` FOR UPDATE; current preferences that fail to parse refuse
   * the save before any write (TM-B1-14). Rows already skipped as
   * `keyword_mismatch` or `excluded_role_family` are never written. Every
   * other redecidable row runs steps 2 and 3 under the current preferences
   * first (`stepsTwoAndThree`, the one implementation); only rows that pass
   * both reach the Match and technology steps. Each write is guarded on the
   * status and reason the save read; zero matched rows is a lock-order bug and
   * throws `job_criteria_save_conflict`, rolling everything back.
   */
  async saveIn(trx: CandidateTx, candidateId: string, request: JobCriteriaRequest): Promise<SaveResult> {
      await applyTransactionTimeouts(trx, SAVE_TIMEOUTS)
      const preferences = await sharePreferences(trx, candidateId)
      const previous = criteriaOf(await criteriaRow(trx, candidateId).forUpdate().executeTakeFirstOrThrow())
      const updated = await trx
        .updateTable("job_criteria")
        .set({
          min_core_match_percent: request.minCoreMatchPercent,
          frameworks: request.frameworks,
          technologies: request.technologies,
          // EPIC-0006: catalog order (the request schema's transform) and the floor. They change no status (AC-4.2).
          target_role_families: request.targetRoleFamilies,
          seniority_floor: request.seniorityFloor,
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where("candidate_id", "=", candidateId)
        .returningAll()
        .executeTakeFirstOrThrow()
      const criteria = criteriaOf(updated)
      const entries = canonicalEntries(criteria.frameworks, criteria.technologies)
      const redecided = !sameDecisionCriteria(previous, criteria)

      const { rows } = redecided ? await decisionRows(trx, candidateId) : { rows: [] }
      // B1 step 2 and 3 first: a redecidable row that fails the current family or keyword is re-skipped by that rule.
      const preferenceSkips: PreferenceSkip[] = []
      const forMatch: DecisionRow[] = []
      for (const row of rows) {
        if (!isRedecidable({ status: row.status, skipReason: row.skip_reason, totalCount: row.total_count })) continue
        const reason = preferences === null ? null : stepsTwoAndThree(preferences.values, { roleFamily: row.role_family, titleFolded: row.title_folded })
        if (reason === null) forMatch.push(row)
        else preferenceSkips.push({ id: row.id, reason, previousStatus: row.status, previousReason: row.skip_reason })
      }
      const { considered: matchConsidered, changed } = redecided ? redecide(forMatch.map(toStoredDecision), decisionCriteria(criteria)) : { considered: 0, changed: [] }
      const considered = matchConsidered + preferenceSkips.length

      if (preferenceSkips.length > 0) {
        await guardedUpdate(
          trx,
          sql`
          update candidate_posting cp
          set status = 'skipped', skip_reason = c.reason, skip_detail = null, preferences_version = ${preferences?.version ?? 0}
          from unnest(${preferenceSkips.map((row) => row.id)}::uuid[], ${preferenceSkips.map((row) => row.reason)}::text[],
                      ${preferenceSkips.map((row) => row.previousStatus)}::text[], ${preferenceSkips.map((row) => row.previousReason)}::text[]) as c(id, reason, old_status, old_reason)
          where cp.candidate_id = ${candidateId}::uuid and cp.job_posting_id = c.id
            and cp.status = c.old_status and cp.skip_reason is not distinct from c.old_reason`,
          preferenceSkips.length
        )
      }
      if (changed.length > 0) {
        const ids = changed.map((row) => row.id)
        const previousReason = new Map(rows.map((row) => [row.id, row.skip_reason]))
        await guardedUpdate(
          trx,
          sql`
          update candidate_posting cp
          set status = c.status, skip_reason = c.reason, skip_detail = null
          from unnest(${ids}::uuid[], ${changed.map((row) => row.status)}::text[], ${changed.map((row) => row.skipReason)}::text[],
                      ${changed.map((row) => row.previousStatus)}::text[], ${changed.map((row) => previousReason.get(row.id) ?? null)}::text[]) as c(id, status, reason, old_status, old_reason)
          where cp.candidate_id = ${candidateId}::uuid and cp.job_posting_id = c.id
            and cp.status = c.old_status and cp.skip_reason is not distinct from c.old_reason`,
          changed.length
        )
        await sql`
          update match_evidence m
          set verdict = c.verdict, weak_reason = c.weak_reason
          from unnest(${ids}::uuid[], ${changed.map((row) => row.verdict)}::text[], ${changed.map((row) => row.weakReason)}::text[]) as c(id, verdict, weak_reason)
          where m.candidate_id = ${candidateId}::uuid and m.job_posting_id = c.id`.execute(trx)
      }
      await sql`
        update match_evidence
        set threshold = ${criteria.minCoreMatchPercent}::numeric / 100,
            criteria_version = ${criteria.version},
            criteria_technologies = ${entries}::text[]
        where candidate_id = ${candidateId}::uuid
          and job_posting_id in (select job_posting_id from candidate_posting where candidate_id = ${candidateId}::uuid and status in ('ranked', 'skipped'))`.execute(trx)
      return { criteria, redecided, considered, changed }
  }
}

type PreferenceSkip = Readonly<{ id: string; reason: "excluded_role_family" | "keyword_mismatch"; previousStatus: string; previousReason: string | null }>

/** B1: a write that matched fewer rows than the save decided means a newer decision is there (a lock-order bug). Never overwrite it. */
export class JobCriteriaSaveConflictError extends Error {
  constructor() {
    super("job_criteria_save_conflict")
    this.name = "JobCriteriaSaveConflictError"
  }
}

async function guardedUpdate(trx: CandidateTx, statement: ReturnType<typeof sql>, expected: number): Promise<void> {
  const result = await statement.execute(trx)
  if (Number(result.numAffectedRows ?? 0n) !== expected) throw new JobCriteriaSaveConflictError()
}

/** EPIC-0006 AC-4.2: only the minimum and the two lists decide a status; families and the floor never do. */
function sameDecisionCriteria(a: StoredJobCriteria, b: StoredJobCriteria): boolean {
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((value, index) => value === y[index])
  return a.minCoreMatchPercent === b.minCoreMatchPercent && same(a.frameworks, b.frameworks) && same(a.technologies, b.technologies)
}

/** Every ranked or skipped posting of the Candidate with Match evidence: the EPIC-0004 re-decision's input. */
function decisionRows(trx: CandidateTx, candidateId: string) {
  return sql<DecisionRow>`
    select p.id, cp.status, cp.skip_reason, p.role_family, p.title_folded, m.verdict, m.covered_count, m.total_count,
           case when p.technologies is null then null
                else array(select e ->> 'name' from jsonb_array_elements(p.technologies) as e
                           where jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'name') = 'string') end as names
    from candidate_posting cp
    join job_posting p on p.id = cp.job_posting_id
    join match_evidence m on m.job_posting_id = cp.job_posting_id and m.candidate_id = cp.candidate_id
    where cp.candidate_id = ${candidateId}::uuid and cp.status in ('ranked', 'skipped')`.execute(trx)
}

function toStoredDecision(row: DecisionRow): StoredDecision {
  return {
    id: row.id,
    status: row.status,
    skipReason: row.skip_reason,
    verdict: row.verdict,
    coveredCount: row.covered_count,
    totalCount: row.total_count,
    technologyNames: row.names,
  }
}
