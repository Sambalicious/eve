import { Inject, Injectable } from "@nestjs/common"
import { ANTHROPIC_TERMS, type AiProviderResponse } from "@eve/contracts"

import { CLOCK, type Clock } from "../shared/clock.js"
import { AiProviderRepository, type RecordedApproval } from "./ai-provider.repository.js"

@Injectable()
export class AiProviderService {
  constructor(
    private readonly repository: AiProviderRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async describe(): Promise<AiProviderResponse> {
    const approval = await this.repository.findApproval()
    return {
      provider: "anthropic",
      name: "Anthropic",
      terms: { ...ANTHROPIC_TERMS },
      approval: approval ? toApprovalView(approval) : null,
    }
  }

  /** Records the terms the backend serves, never text from the request (C-AI-3). */
  async approve(): Promise<AiProviderResponse> {
    await this.repository.recordApproval({
      approvedAt: this.clock.now(),
      termsCheckedOn: ANTHROPIC_TERMS.checkedOn,
      trainingLine: ANTHROPIC_TERMS.trainingLine,
      retentionLine: ANTHROPIC_TERMS.retentionLine,
      whatsSentLine: ANTHROPIC_TERMS.whatsSentLine,
    })
    return this.describe()
  }
}

function toApprovalView(approval: RecordedApproval): NonNullable<AiProviderResponse["approval"]> {
  return {
    approvedAt: approval.approvedAt.toISOString(),
    termsCheckedOn: approval.termsCheckedOn,
    trainingLine: approval.trainingLine,
    retentionLine: approval.retentionLine,
    whatsSentLine: approval.whatsSentLine,
  }
}
