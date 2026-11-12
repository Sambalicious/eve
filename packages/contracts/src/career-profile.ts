import { z } from "zod"

export const CAREER_PROFILE_PATH = "/v1/career-profile"
export const CAREER_PROFILE_RESUME_PATH = "/v1/career-profile/resume"
export const CAREER_PROFILE_DRAFT_PATH = "/v1/career-profile/draft"
export const CAREER_PROFILE_DRAFT_APPROVE_PATH = "/v1/career-profile/draft/approve"
export const careerProfileVersionPath = (version: number) => `/v1/career-profile/versions/${version}`

/** Resume upload rules (C-VAL-PROFILE-1). Checked by content, not only by extension. */
export const RESUME_MAX_BYTES = 5 * 1024 * 1024
export const RESUME_FILE_FIELD = "resume"
export const resumeMediaTypeSchema = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
])
export type ResumeMediaType = z.infer<typeof resumeMediaTypeSchema>

export const CAREER_PROFILE_LIMITS = {
  sections: 50,
  factsPerSection: 50,
  textLength: 1000,
  titleLength: 300,
} as const

export const careerProfileSectionKindSchema = z.enum(["experience", "education", "skills", "summary", "other"])

/** A fact. `sourceQuote` is the resume text it came from; null for facts the Candidate wrote or edited. */
export const careerProfileFactSchema = z
  .object({ id: z.string(), text: z.string(), sourceQuote: z.string().nullable() })
  .strict()
export type CareerProfileFact = z.infer<typeof careerProfileFactSchema>

export const careerProfileSectionSchema = z
  .object({
    id: z.string(),
    kind: careerProfileSectionKindSchema,
    title: z.string(),
    organization: z.string().nullable(),
    period: z.string().nullable(),
    sourceQuote: z.string().nullable(),
    facts: z.array(careerProfileFactSchema),
  })
  .strict()
export type CareerProfileSection = z.infer<typeof careerProfileSectionSchema>

export const careerProfileVersionStatusSchema = z.enum(["draft", "approved", "replaced"])

export const careerProfileVersionSummarySchema = z
  .object({
    version: z.number().int().positive(),
    status: careerProfileVersionStatusSchema,
    source: z.enum(["resume", "edit"]),
    createdAt: z.iso.datetime({ offset: true }),
    approvedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
export type CareerProfileVersionSummary = z.infer<typeof careerProfileVersionSummarySchema>

/** `droppedFactCount`: facts the model proposed that were dropped because their quote is not in the resume. */
export const careerProfileVersionSchema = careerProfileVersionSummarySchema
  .extend({ sections: z.array(careerProfileSectionSchema), droppedFactCount: z.number().int().nonnegative() })
  .strict()
export type CareerProfileVersion = z.infer<typeof careerProfileVersionSchema>

export const resumeDraftingFailureSchema = z.enum([
  "not_approved",
  "not_configured",
  "provider_error",
  "invalid_output",
  "no_verified_facts",
  "timed_out",
  // v1.2.0 (QA-F2): the server could not store the file; nothing was sent to Anthropic.
  "storage_error",
  // v1.3.0 (CR2-06): Anthropic answered, but a draft version appeared meanwhile; the
  // existing draft is kept and nothing replaced it.
  "draft_exists",
  // v1.11.0: drafting would take the month over its cost ceiling, or paid automation is paused for cost.
  "cost_paused",
])

/** Latest resume drafting attempt while it runs or after it failed (C-PROFILE-2, C-PROFILE-4). */
export const resumeDraftingSchema = z
  .object({
    status: z.enum(["drafting", "failed"]),
    filename: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    failureReason: resumeDraftingFailureSchema.nullable(),
  })
  .strict()
export type ResumeDrafting = z.infer<typeof resumeDraftingSchema>

/** `GET /v1/career-profile`. `inUse` is the approved version new Tailored Documents use. */
export const careerProfileResponseSchema = z
  .object({
    inUse: careerProfileVersionSchema.nullable(),
    draft: careerProfileVersionSchema.nullable(),
    drafting: resumeDraftingSchema.nullable(),
    history: z.array(careerProfileVersionSummarySchema),
  })
  .strict()
export type CareerProfileResponse = z.infer<typeof careerProfileResponseSchema>

/** `PUT /v1/career-profile/draft`. Omit `id` for a new section or fact. Empty fact text is saved and refused on approval. */
export const saveCareerProfileDraftRequestSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            id: z.string().optional(),
            kind: careerProfileSectionKindSchema,
            title: z.string().trim().min(1).max(CAREER_PROFILE_LIMITS.titleLength),
            organization: z.string().trim().max(CAREER_PROFILE_LIMITS.titleLength).nullable(),
            period: z.string().trim().max(100).nullable(),
            facts: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    text: z.string().max(CAREER_PROFILE_LIMITS.textLength),
                  })
                  .strict()
              )
              .max(CAREER_PROFILE_LIMITS.factsPerSection),
          })
          .strict()
      )
      .min(1)
      .max(CAREER_PROFILE_LIMITS.sections),
  })
  .strict()
export type SaveCareerProfileDraftRequest = z.infer<typeof saveCareerProfileDraftRequestSchema>

/** `POST /v1/career-profile/draft/approve`. `version` must be the current draft's number. */
export const approveCareerProfileDraftRequestSchema = z
  .object({ version: z.number().int().positive() })
  .strict()
export type ApproveCareerProfileDraftRequest = z.infer<typeof approveCareerProfileDraftRequestSchema>
