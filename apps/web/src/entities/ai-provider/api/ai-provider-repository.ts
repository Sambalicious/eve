import {
  AI_PROVIDER_APPROVAL_PATH,
  AI_PROVIDER_PATH,
  aiProviderResponseSchema,
  type AiProviderResponse,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { AiProvider } from "../model/ai-provider"

export async function fetchAiProvider(): Promise<AiProvider> {
  const response = await apiRequest(AI_PROVIDER_PATH)
  return toAiProvider(aiProviderResponseSchema.parse(await response.json()))
}

/**
 * Approves Anthropic under the terms version the Candidate was shown. The API
 * refuses any other version, so a stale page cannot approve terms it did not show.
 */
export async function approveAiProvider(termsCheckedOn: string, csrfToken: string): Promise<AiProvider> {
  const response = await apiRequest(AI_PROVIDER_APPROVAL_PATH, {
    method: "POST",
    csrfToken,
    json: { termsCheckedOn },
  })
  return toAiProvider(aiProviderResponseSchema.parse(await response.json()))
}

function toAiProvider(body: AiProviderResponse): AiProvider {
  const { terms, approval } = body
  return {
    name: body.name,
    terms: {
      checkedOn: terms.checkedOn,
      trainingLine: terms.trainingLine,
      retentionLine: terms.retentionLine,
      whatsSentLine: terms.whatsSentLine,
      trainingTermsUrl: terms.trainingTermsUrl,
      retentionTermsUrl: terms.retentionTermsUrl,
    },
    approval: approval && {
      approvedAt: approval.approvedAt,
      termsCheckedOn: approval.termsCheckedOn,
      trainingLine: approval.trainingLine,
      retentionLine: approval.retentionLine,
    },
  }
}
