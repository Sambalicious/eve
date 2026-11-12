import { Injectable } from "@nestjs/common"

import { TenantDatabase } from "../db/tenant-database.js"

export type RecordedApproval = Readonly<{
  approvedAt: Date
  termsCheckedOn: string
  trainingLine: string
  retentionLine: string
  whatsSentLine: string
}>

/**
 * `ai_provider_approval` is one shared row until `ai_terms_record` and the
 * per-Candidate approval (slices A2 and C). Reads and writes still need a
 * Candidate scope, because only a Candidate's action or job reaches them.
 */
@Injectable()
export class AiProviderRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  async findApproval(): Promise<RecordedApproval | undefined> {
    const row = await this.tenant.run((tx) =>
      tx
        .selectFrom("ai_provider_approval")
        .select([
          "approved_at",
          (eb) => eb.cast<string>("terms_checked_on", "text").as("terms_checked_on"),
          "training_line",
          "retention_line",
          "whats_sent_line",
        ])
        .where("provider", "=", "anthropic")
        .executeTakeFirst()
    )
    if (!row) return undefined
    return {
      approvedAt: row.approved_at,
      termsCheckedOn: row.terms_checked_on,
      trainingLine: row.training_line,
      retentionLine: row.retention_line,
      whatsSentLine: row.whats_sent_line,
    }
  }

  /** First approval wins; approving again keeps the original record. */
  async recordApproval(approval: RecordedApproval): Promise<RecordedApproval> {
    await this.tenant.run((tx) =>
      tx
        .insertInto("ai_provider_approval")
        .values({
          provider: "anthropic",
          approved_at: approval.approvedAt,
          terms_checked_on: approval.termsCheckedOn,
          training_line: approval.trainingLine,
          retention_line: approval.retentionLine,
          whats_sent_line: approval.whatsSentLine,
        })
        .onConflict((oc) => oc.column("provider").doNothing())
        .execute()
    )
    const recorded = await this.findApproval()
    if (!recorded) throw new Error("Approval was not recorded")
    return recorded
  }
}
