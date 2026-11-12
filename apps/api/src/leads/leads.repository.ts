import { Injectable } from "@nestjs/common"
import { type Lead, type LeadStage, LEADS_LIMIT, type LeadsResponse } from "@eve/contracts"

import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"

type Row = {
  job_posting_id: string
  stage: string
  stage_changed_at: Date
  title: string | null
  company: string | null
  role_family: string | null
  status: string
  skip_reason: string | null
  application_system: string
  application_id: string | null
}

const toLead = (row: Row): Lead => ({
  jobPostingId: row.job_posting_id,
  stage: row.stage as LeadStage,
  stageChangedAt: row.stage_changed_at.toISOString(),
  roleTitle: row.title,
  company: row.company,
  roleFamily: (row.role_family ?? null) as Lead["roleFamily"],
  postingStatus: row.status as Lead["postingStatus"],
  skipReason: (row.skip_reason ?? null) as Lead["skipReason"],
  applicationSystem: row.application_system,
  applicationId: row.application_id,
})

/**
 * v1.29.0 lead pipeline. Candidate-scoped through `TenantDatabase` (the session
 * interceptor sets the scope), so every statement runs under RLS for the one
 * Candidate. A lead is an upsert keyed to `candidate_posting`, so it can never
 * name a posting the Candidate does not hold.
 */
@Injectable()
export class LeadsRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  list(): Promise<LeadsResponse> {
    return this.tenant.run(async (tx, candidateId) => {
      const rows = await tx
        .selectFrom("lead")
        .innerJoin("candidate_posting as cp", (join) =>
          join.onRef("cp.candidate_id", "=", "lead.candidate_id").onRef("cp.job_posting_id", "=", "lead.job_posting_id")
        )
        .innerJoin("job_posting as p", "p.id", "lead.job_posting_id")
        .leftJoin("application as a", (join) =>
          join.onRef("a.candidate_id", "=", "lead.candidate_id").onRef("a.job_posting_id", "=", "lead.job_posting_id")
        )
        .select([
          "lead.job_posting_id",
          "lead.stage",
          "lead.stage_changed_at",
          "p.title",
          "p.company",
          "p.role_family",
          "cp.status",
          "cp.skip_reason",
          "p.application_system",
          "a.id as application_id",
        ])
        .where("lead.candidate_id", "=", candidateId)
        .orderBy("lead.stage_changed_at", "desc")
        .orderBy("lead.job_posting_id")
        .limit(LEADS_LIMIT)
        .execute()
      return { leads: rows.map((row) => toLead(row as unknown as Row)) }
    })
  }

  /** Moves a lead to `stage`, creating it on first use. Undefined when the Candidate does not hold the posting. */
  setStage(jobPostingId: string, stage: LeadStage, at: Date): Promise<Lead | undefined> {
    return this.tenant.run(async (tx, candidateId) => {
      const held = await tx
        .selectFrom("candidate_posting")
        .select("job_posting_id")
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", jobPostingId)
        .executeTakeFirst()
      if (!held) return undefined
      await tx
        .insertInto("lead")
        .values({ candidate_id: candidateId, job_posting_id: jobPostingId, stage, stage_changed_at: at, created_at: at })
        .onConflict((conflict) =>
          conflict.columns(["candidate_id", "job_posting_id"]).doUpdateSet({ stage, stage_changed_at: at })
        )
        .execute()
      const rows = await this.listRows(tx, candidateId, jobPostingId)
      const row = rows[0]
      return row === undefined ? undefined : toLead(row as unknown as Row)
    })
  }

  /** Removes the lead. True when a row was deleted. */
  remove(jobPostingId: string): Promise<boolean> {
    return this.tenant.run(async (tx, candidateId) => {
      const result = await tx
        .deleteFrom("lead")
        .where("candidate_id", "=", candidateId)
        .where("job_posting_id", "=", jobPostingId)
        .executeTakeFirst()
      return Number(result.numDeletedRows) > 0
    })
  }

  private async listRows(tx: CandidateTx, candidateId: string, jobPostingId: string) {
    return tx
      .selectFrom("lead")
      .innerJoin("candidate_posting as cp", (join) =>
        join.onRef("cp.candidate_id", "=", "lead.candidate_id").onRef("cp.job_posting_id", "=", "lead.job_posting_id")
      )
      .innerJoin("job_posting as p", "p.id", "lead.job_posting_id")
      .leftJoin("application as a", (join) =>
        join.onRef("a.candidate_id", "=", "lead.candidate_id").onRef("a.job_posting_id", "=", "lead.job_posting_id")
      )
      .select([
        "lead.job_posting_id",
        "lead.stage",
        "lead.stage_changed_at",
        "p.title",
        "p.company",
        "p.role_family",
        "cp.status",
        "cp.skip_reason",
        "p.application_system",
        "a.id as application_id",
      ])
      .where("lead.candidate_id", "=", candidateId)
      .where("lead.job_posting_id", "=", jobPostingId)
      .execute()
  }
}
