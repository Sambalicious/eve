import { randomUUID } from "node:crypto"

import { Inject, Injectable, Logger } from "@nestjs/common"
import type { MinimalRecordsResponse, Outcome, OutcomeTypeValue, OutcomesResponse } from "@eve/contracts"
import { type Selectable } from "kysely"

import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import type { OutcomeTable } from "../db/schema.js"
import { CandidateScope } from "../db/candidate-scope.js"
import { CandidateFiles } from "../files/candidate-files.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { deleteDetailsLocked, isBusy, outreachRunning } from "./details-deletion.js"
import { publicLink } from "../discovery/pasted-description-store.js"


/**
 * Manual Outcomes (AC 8) and deleting detailed records (AC 10.3, 10.4).
 *
 * Deleting keeps the `application` row as the minimal requisition record
 * (company, employer application URL, requisition ID, date, final status), so
 * its unique requisition key still refuses a second Application. Everything
 * else goes: Tailored Documents and their files, the stored form read (the
 * questions behind the answers), Outcomes, notification rows, submission
 * events (they name evidence files) and the detailed columns on the row.
 * Clearing the minimal record deletes the row, so the requisition can be
 * applied to again.
 *
 * EPIC-0002 A1: every statement runs in the session Candidate's `CandidateTx`
 * and names its `candidate_id`; another Candidate's IDs are 404.
 */
@Injectable()
export class RecordsService {
  private readonly logger = new Logger(RecordsService.name)

  constructor(
    private readonly tenant: TenantDatabase,
    private readonly files: CandidateFiles,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async outcomes(applicationId: string): Promise<OutcomesResponse> {
    const rows = await this.tenant.run(async (tx, candidateId) => {
      await liveApplication(tx, candidateId, applicationId)
      return tx.selectFrom("outcome").selectAll().where("candidate_id", "=", candidateId).where("application_id", "=", applicationId).orderBy("created_at").orderBy("id").execute()
    })
    return { outcomes: rows.map(outcomeOf) }
  }

  /**
   * CR7-02: the liveness check takes the Application row FOR SHARE in the same
   * transaction as the insert, so a deletion (FOR UPDATE) either commits first
   * and this is 409, or waits until the Outcome is in and then deletes it too.
   */
  async recordOutcome(applicationId: string, type: OutcomeTypeValue): Promise<Outcome> {
    return this.tenant.run(async (trx, candidateId) => {
      const live = await trx.selectFrom("application").select("details_deleted_at").where("candidate_id", "=", candidateId).where("id", "=", applicationId).forShare().executeTakeFirst()
      if (!live) throw new ApiException("not_found")
      if (live.details_deleted_at !== null) throw new ApiException("application_state_conflict")
      const now = this.clock.now()
      const row = await trx
        .insertInto("outcome")
        .values({ id: randomUUID(), candidate_id: candidateId, application_id: applicationId, type, excerpt: null, created_at: now, updated_at: now })
        .returningAll()
        .executeTakeFirstOrThrow()
      return outcomeOf(row)
    })
  }

  /** AC 8.2: only the type changes; a stored excerpt stays as it was (OQ-D15). */
  async editOutcome(outcomeId: string, type: OutcomeTypeValue): Promise<Outcome> {
    const row = await this.tenant.run((tx, candidateId) =>
      tx.updateTable("outcome").set({ type, updated_at: this.clock.now() }).where("candidate_id", "=", candidateId).where("id", "=", outcomeId).returningAll().executeTakeFirst()
    )
    if (!row) throw new ApiException("not_found")
    return outcomeOf(row)
  }

  /**
   * AC 10.3. Idempotent: an Application already deleted is left as it is and
   * not counted. Unknown IDs are 404 and nothing is deleted. An Application
   * whose browser attempt may be running, or whose documents are being
   * generated (SEC-701), is refused (409) and nothing is deleted.
   */
  async deleteDetails(applicationIds: readonly string[]): Promise<{ deletedCount: number }> {
    const ids = [...new Set(applicationIds)]
    const now = this.clock.now()
    const result = await this.tenant.run(async (trx, candidateId) => {
      const rows = await trx.selectFrom("application").select(["id", "details_deleted_at", "submission_state", "state"]).where("candidate_id", "=", candidateId).where("id", "in", ids).forUpdate().execute()
      if (rows.length !== ids.length) throw new ApiException("not_found")
      const live = rows.filter((row) => row.details_deleted_at === null)
      // EPIC-0014 D3 (AC 12.3): a live Outreach Run makes the Application busy, so bulk stays all or nothing.
      if (live.some(isBusy) || (await outreachRunning(trx, candidateId, live.map((row) => row.id), now))) throw new ApiException("application_state_conflict")
      return deleteDetailsLocked(trx, candidateId, live, now, "candidate")
    })
    await this.removeDocumentFiles(result.fileNames)
    return { deletedCount: result.deletedIds.length }
  }

  async minimalRecords(): Promise<MinimalRecordsResponse> {
    const rows = await this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("application")
        .select(["id", "company", "application_url", "requisition_id", "created_at", "details_deleted_at", "final_status", "details_deleted_by"])
        .where("candidate_id", "=", candidateId)
        .where("details_deleted_at", "is not", null)
        .orderBy("details_deleted_at", "desc")
        .orderBy("id")
        .limit(500)
        .execute()
    )
    return {
      records: rows.map((row) => ({
        applicationId: row.id,
        company: row.company,
        // v1.27.0: null for a description-only pasted Application (the synthetic URN never leaves the API).
        applicationUrl: publicLink(row.application_url),
        requisitionId: row.requisition_id,
        createdAt: row.created_at.toISOString(),
        detailsDeletedAt: row.details_deleted_at!.toISOString(),
        finalStatus: row.final_status ?? "unknown",
        // E6.1: rows an older api deleted have no value; only the Candidate deleted before the job existed.
        deletedBy: row.details_deleted_by ?? "candidate",
      })),
    }
  }

  /**
   * AC 10.4: clearing removes the minimal record, so the requisition is no
   * longer blocked. Only a minimal record can be cleared (409 otherwise). AI
   * call and spend rows keep their numbers and lose the link (on delete set null).
   */
  async clearMinimalRecord(applicationId: string): Promise<void> {
    await this.tenant.run(async (trx, candidateId) => {
      const row = await trx.selectFrom("application").select(["id", "job_posting_id", "details_deleted_at"]).where("candidate_id", "=", candidateId).where("id", "=", applicationId).forUpdate().executeTakeFirst()
      if (!row) throw new ApiException("not_found")
      if (row.details_deleted_at === null) throw new ApiException("application_state_conflict")
      await trx.deleteFrom("application").where("candidate_id", "=", candidateId).where("id", "=", applicationId).execute()
      // This Candidate's posting row would otherwise find the requisition already stored and never offer it again.
      // Their Eligibility and Match evidence go with it (foreign keys to candidate_posting, cascade).
      await trx.deleteFrom("candidate_posting").where("candidate_id", "=", candidateId).where("job_posting_id", "=", row.job_posting_id).execute()
      await deleteUnheldPosting(this.tenant, trx, row.job_posting_id)
    })
  }

  private async removeDocumentFiles(names: readonly string[]): Promise<void> {
    const candidateId = CandidateScope.require()
    await Promise.all(
      names.map((name) =>
        this.files.remove(candidateId, "documents", name).catch((error: unknown) => {
          this.logger.warn(`Could not remove a document file: ${error instanceof Error ? error.name : "unknown"}`)
        })
      )
    )
  }
}

/**
 * Deletes the shared posting only when no Candidate holds it any more (item 6,
 * architecture r4 C24). RLS hides other Candidates' rows, so this cannot check
 * for them; the foreign keys can (`candidate_posting` and `application` both
 * restrict, and foreign key checks ignore RLS). A refused delete is rolled back
 * to a savepoint (TenantDatabase.savepoint, run a2c) and the posting stays.
 */
async function deleteUnheldPosting(tenant: TenantDatabase, tx: CandidateTx, jobPostingId: string): Promise<void> {
  await tenant.savepoint(tx, () => tx.deleteFrom("job_posting").where("id", "=", jobPostingId).execute(), isForeignKeyViolation)
}

/** Postgres `foreign_key_violation` (23503). */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "23503"
}

async function liveApplication(tx: CandidateTx, candidateId: string, applicationId: string): Promise<void> {
  const row = await tx.selectFrom("application").select(["id", "details_deleted_at"]).where("candidate_id", "=", candidateId).where("id", "=", applicationId).executeTakeFirst()
  if (!row) throw new ApiException("not_found")
  if (row.details_deleted_at !== null) throw new ApiException("application_state_conflict")
}

function outcomeOf(row: Selectable<OutcomeTable>): Outcome {
  return {
    id: row.id,
    applicationId: row.application_id,
    type: row.type,
    source: "candidate",
    excerpt: row.excerpt,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}
