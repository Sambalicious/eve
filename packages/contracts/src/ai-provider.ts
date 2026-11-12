import { z } from "zod"

export const AI_PROVIDER_PATH = "/v1/ai-provider"
export const AI_PROVIDER_APPROVAL_PATH = "/v1/ai-provider/approval"

/**
 * Anthropic's terms summary (design-spec C-AI-3, architecture.r1 S10 and S11).
 * The backend records exactly these lines with the approval; the dashboard shows
 * the same text from `GET /v1/ai-provider`.
 */
export const ANTHROPIC_TERMS = {
  checkedOn: "2026-10-16",
  trainingLine:
    "Training: Anthropic doesn't train on API inputs and outputs by default. Thumbs-up or thumbs-down feedback is kept for 5 years and may be used.",
  retentionLine:
    "Retention: inputs and outputs are deleted within 30 days, except content flagged under Anthropic's Usage Policy, which can be kept up to 2 years.",
  whatsSentLine:
    "What's sent: your resume, Career Profile, Approved Answers and Job Posting analysis that includes career data. Nothing goes to Anthropic until you approve.",
  trainingTermsUrl: "https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training",
  retentionTermsUrl:
    "https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
} as const

const termsSchema = z
  .object({
    checkedOn: z.iso.date(),
    trainingLine: z.string(),
    retentionLine: z.string(),
    whatsSentLine: z.string(),
    trainingTermsUrl: z.url(),
    retentionTermsUrl: z.url(),
  })
  .strict()

export const aiProviderApprovalSchema = z
  .object({
    approvedAt: z.iso.datetime({ offset: true }),
    termsCheckedOn: z.iso.date(),
    trainingLine: z.string(),
    retentionLine: z.string(),
    whatsSentLine: z.string(),
  })
  .strict()
export type AiProviderApproval = z.infer<typeof aiProviderApprovalSchema>

/** `GET /v1/ai-provider`: the only provider is Anthropic (Candidate decision r2). */
export const aiProviderResponseSchema = z
  .object({
    provider: z.literal("anthropic"),
    name: z.literal("Anthropic"),
    terms: termsSchema,
    approval: aiProviderApprovalSchema.nullable(),
  })
  .strict()
export type AiProviderResponse = z.infer<typeof aiProviderResponseSchema>

/**
 * `POST /v1/ai-provider/approval`: names the terms version the Operator saw.
 * Operator only (EPIC-0002 A2): any other Candidate gets 404 `not_found`.
 */
export const approveAiProviderRequestSchema = z
  .object({ termsCheckedOn: z.literal(ANTHROPIC_TERMS.checkedOn) })
  .strict()
export type ApproveAiProviderRequest = z.infer<typeof approveAiProviderRequestSchema>
