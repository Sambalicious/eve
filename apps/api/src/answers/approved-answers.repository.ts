import { Injectable } from "@nestjs/common"
import type { Selectable } from "kysely"

import type { ApprovedAnswerTable } from "../db/schema.js"
import { TenantDatabase } from "../db/tenant-database.js"

export type ApprovedAnswerRow = Selectable<ApprovedAnswerTable>

const UNIQUE_VIOLATION = "23505"

/** The scope's Candidate's Approved Answers only: every statement runs in its `CandidateTx` and names its `candidate_id`. */
@Injectable()
export class ApprovedAnswersRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  list(): Promise<ApprovedAnswerRow[]> {
    return this.tenant.run((tx, candidateId) =>
      tx
        .selectFrom("approved_answer")
        .selectAll()
        .where("candidate_id", "=", candidateId)
        .orderBy("answer_group")
        .orderBy("created_at")
        .orderBy("id")
        .execute()
    )
  }

  /** Returns undefined when this Candidate already has an answer for the same question. */
  async insert(row: Omit<ApprovedAnswerRow, "candidate_id">): Promise<ApprovedAnswerRow | undefined> {
    try {
      return await this.tenant.run((tx, candidateId) =>
        tx.insertInto("approved_answer").values({ ...row, candidate_id: candidateId }).returningAll().executeTakeFirstOrThrow()
      )
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return undefined
      throw error
    }
  }

  updateValue(id: string, value: string, updatedAt: Date): Promise<ApprovedAnswerRow | undefined> {
    return this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("approved_answer")
        .set({ value, updated_at: updatedAt })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst()
    )
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.tenant.run((tx, candidateId) =>
      tx.deleteFrom("approved_answer").where("candidate_id", "=", candidateId).where("id", "=", id).executeTakeFirst()
    )
    return result.numDeletedRows > 0n
  }
}
