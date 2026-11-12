/** AI provider copy from design-spec.r3.md, copy catalogue C-AI-*. Exact strings. */
export const aiProviderCopy = {
  homeAlert:
    "Anthropic isn't approved yet, so no career data is processed. Resume drafting, documents and matching wait until you approve it.", // C-AI-1
  reviewAndApprove: "Review and approve",
  heading: "AI provider: Anthropic (paid API)", // C-AI-2
  sourceLine: (checkedOn: string) => `Summary of Anthropic's published terms, checked ${checkedOn}.`, // C-AI-4
  trainingTerms: "Training terms",
  retentionTerms: "Retention terms",
  approveButton: "Approve Anthropic",
  /**
   * C-AI-5 (r3): "Anthropic approved on {date}." then the recorded
   * `trainingLine` and `retentionLine`, each on its own line, exactly as stored.
   */
  approved: (date: string) => `Anthropic approved on ${date}.`,
  confirm: {
    title: "Approve Anthropic?",
    body: "Your resume, Career Profile, Approved Answers and Job Posting analysis will be sent to Anthropic under the terms shown. These terms are recorded with your approval.",
    confirm: "Approve Anthropic",
  }, // C-CONFIRM-15
} as const
