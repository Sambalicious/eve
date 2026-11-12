/** The AI provider (Anthropic, fixed by the r2 Candidate decision) and its approval. */
export interface AiProviderTerms {
  /** `YYYY-MM-DD`: when the terms summary was last checked. */
  readonly checkedOn: string
  readonly trainingLine: string
  readonly retentionLine: string
  readonly whatsSentLine: string
  readonly trainingTermsUrl: string
  readonly retentionTermsUrl: string
}

/** The terms recorded at approval, exactly as they were shown. */
export interface AiProviderApproval {
  readonly approvedAt: string
  readonly termsCheckedOn: string
  readonly trainingLine: string
  readonly retentionLine: string
}

export interface AiProvider {
  readonly name: string
  readonly terms: AiProviderTerms
  readonly approval: AiProviderApproval | null
}
