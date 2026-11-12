import { Injectable } from "@nestjs/common"
import type { Selectable } from "kysely"

import type { GrossSalaryAnswerTable, PreferredNetPayTable } from "../db/schema.js"
import { TenantDatabase } from "../db/tenant-database.js"

export type GrossKind = GrossSalaryAnswerTable["kind"]
export type GrossRow = Selectable<GrossSalaryAnswerTable>
export type NetRow = Selectable<PreferredNetPayTable>

/**
 * Gross figures and the preferred net pay live in different tables. Nothing that
 * reads a gross figure can select the net row (AC 1.4). Every statement is
 * scoped to the scope's Candidate (EPIC-0002 A1).
 */
@Injectable()
export class SalaryRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  findGross(kind: GrossKind): Promise<GrossRow | undefined> {
    return this.tenant.run((tx, candidateId) =>
      tx.selectFrom("gross_salary_answer").selectAll().where("candidate_id", "=", candidateId).where("kind", "=", kind).executeTakeFirst()
    )
  }

  async upsertGross(row: Omit<GrossRow, "amount" | "candidate_id"> & { amount: string }): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .insertInto("gross_salary_answer")
        .values({ ...row, candidate_id: candidateId })
        .onConflict((oc) =>
          oc.columns(["candidate_id", "kind"]).doUpdateSet({
            amount: row.amount,
            currency: row.currency,
            period: row.period,
            updated_at: row.updated_at,
          })
        )
        .execute()
    )
  }

  async deleteGross(kind: GrossKind): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx.deleteFrom("gross_salary_answer").where("candidate_id", "=", candidateId).where("kind", "=", kind).execute()
    )
  }

  findNet(): Promise<NetRow | undefined> {
    return this.tenant.run((tx, candidateId) => tx.selectFrom("preferred_net_pay").selectAll().where("candidate_id", "=", candidateId).executeTakeFirst())
  }

  async upsertNet(amount: string, currency: string, updatedAt: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .insertInto("preferred_net_pay")
        .values({ candidate_id: candidateId, amount, currency, updated_at: updatedAt })
        .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ amount, currency, updated_at: updatedAt }))
        .execute()
    )
  }

  async deleteNet(): Promise<void> {
    await this.tenant.run((tx, candidateId) => tx.deleteFrom("preferred_net_pay").where("candidate_id", "=", candidateId).execute())
  }

  /** The Candidate's setting row; a Candidate without one reads the default (empty, read as Nigeria only). */
  async readWorkAuthorization(): Promise<string> {
    const row = await this.tenant.run((tx, candidateId) =>
      tx.selectFrom("candidate_setting").select("work_authorization").where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()
    )
    return row.work_authorization
  }

  async writeWorkAuthorization(value: string, updatedAt: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx.updateTable("candidate_setting").set({ work_authorization: value, updated_at: updatedAt }).where("candidate_id", "=", candidateId).execute()
    )
  }
}
