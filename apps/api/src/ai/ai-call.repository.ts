import { Injectable } from "@nestjs/common"

import type { AiCallStatus } from "../db/schema.js"
import { TenantDatabase } from "../db/tenant-database.js"

export type TokenUsage = Readonly<{
  inputTokens: number | null
  outputTokens: number | null
  cacheReadInputTokens: number | null
  cacheCreationInputTokens: number | null
}>

export const NO_USAGE: TokenUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
}

/**
 * Per-call token metering. Rows hold no career data; the cost ceiling reads them later.
 * EPIC-0002 A1: each row belongs to the scope's Candidate. A call outside any
 * scope is refused rather than written as a shared (null) row: shared posting
 * extraction (slice B) will write through `forShared` explicitly.
 */
@Injectable()
export class AiCallRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  async start(call: {
    id: string
    purpose: string
    model: string
    resumeUploadId: string | null
    jobPostingId?: string | null
    applicationId?: string | null
    startedAt: Date
  }): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .insertInto("ai_call")
        .values({
          id: call.id,
          candidate_id: candidateId,
          purpose: call.purpose,
          provider: "anthropic",
          model: call.model,
          status: "started",
          resume_upload_id: call.resumeUploadId,
          job_posting_id: call.jobPostingId ?? null,
          application_id: call.applicationId ?? null,
          started_at: call.startedAt,
        })
        .execute()
    )
  }

  async finish(id: string, status: Exclude<AiCallStatus, "started">, usage: TokenUsage, finishedAt: Date): Promise<void> {
    await this.tenant.run((tx, candidateId) =>
      tx
        .updateTable("ai_call")
        .set({
          status,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens,
          cache_creation_input_tokens: usage.cacheCreationInputTokens,
          finished_at: finishedAt,
        })
        .where("candidate_id", "=", candidateId)
        .where("id", "=", id)
        .execute()
    )
  }
}
