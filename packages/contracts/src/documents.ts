import { z } from "zod"

import { applicationOverrideSchema, applicationPostingStateSchema, createApplicationAcknowledgementSchema, latestDropSchema } from "./override.js"

/** v1.5.0 (slice 4): Applications in the prepared state and Tailored Documents. */
export const APPLICATIONS_PATH = "/v1/applications"
export const applicationPath = (id: string) => `/v1/applications/${id}`
export const applicationDocumentsGeneratePath = (id: string) => `/v1/applications/${id}/documents/generate`
export const documentDownloadPath = (applicationId: string, kind: DocumentKindValue, format: DocumentFormatValue) =>
  `/v1/applications/${applicationId}/documents/${kind === "cover_letter" ? "cover-letter" : "resume"}.${format}`
export const DOCUMENTS_PATH = "/v1/documents"
export const CANDIDATE_CONTACT_PATH = "/v1/candidate-settings/contact"

export const documentKindSchema = z.enum(["resume", "cover_letter"])
export type DocumentKindValue = z.infer<typeof documentKindSchema>
export const documentFormatSchema = z.enum(["pdf", "docx"])
export type DocumentFormatValue = z.infer<typeof documentFormatSchema>

export const applicationStateSchema = z.enum([
  /** Created from a ranked posting; no documents yet. */
  "prepared",
  /** Documents are being generated. */
  "generating",
  /** Both documents passed validation and were rendered. */
  "documents_ready",
  /** A document had a claim with no matching Career Profile fact (C-DOC-3). The Application does not proceed. */
  "documents_blocked",
  /** Generation could not run or finish (see `failure`). */
  "documents_failed",
])
export type ApplicationStateValue = z.infer<typeof applicationStateSchema>

export const documentFailureSchema = z.enum([
  "not_approved",
  "not_configured",
  "provider_error",
  "invalid_output",
  "timed_out",
  "no_career_profile",
  "render_check_failed",
  /** v1.5.1: the rendered files could not be written (disk full, permissions). The model call succeeded. */
  "storage_error",
  /** v1.5.1: the api restarted while generating. Generate again to retry. */
  "interrupted",
])

/**
 * ATS match of a tailored resume against its posting's keywords (technologies and key skills).
 * `missing`: in the Career Profile but not in this resume; `gaps`: not in the Career Profile either.
 */
export const atsScoreSchema = z
  .object({
    score: z.int().min(0).max(100),
    total: z.int().nonnegative(),
    matched: z.array(z.string()),
    missing: z.array(z.string()),
    gaps: z.array(z.string()),
  })
  .strict()
export type AtsScore = z.infer<typeof atsScoreSchema>

export const tailoredDocumentSchema = z
  .object({
    kind: documentKindSchema,
    careerProfileVersion: z.int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    /** Relative download paths; always http(s)-free, same origin. */
    pdfUrl: z.string().startsWith("/v1/"),
    docxUrl: z.string().startsWith("/v1/"),
    /** The rendered text in reading order, for an accessible preview next to the PDF. */
    previewText: z.array(z.string()),
    /** Resumes only, and only those written after ATS scoring shipped; otherwise null. */
    ats: atsScoreSchema.nullable(),
  })
  .strict()
export type TailoredDocument = z.infer<typeof tailoredDocumentSchema>

/**
 * v1.30.0 (EPIC-0009 D2, OD-1): why a blocked paragraph was blocked. The seven stored causes.
 * `fallback` is not a value: the web shows it for a null, absent or unrecognised cause.
 * Used for api typing and for narrowing in the web. Never used as the wire type (see `blockedClaimCause`).
 */
export const BLOCKED_CLAIM_CAUSES = [
  "unsupported_terms",
  "number_order",
  "no_fact",
  "contact_detail",
  "names_target",
  "unknown_fact",
  "not_confirmed",
] as const
export const blockedClaimCauseSchema = z.enum(BLOCKED_CLAIM_CAUSES)
export type BlockedClaimCause = z.infer<typeof blockedClaimCauseSchema>
/** v1.30.0 (EPIC-0009 D2a): the causes that carry `blockedClaimTerms` and `blockedClaimMoreTerms`. */
export const BLOCKED_CLAIM_TERMS_CAUSES = ["unsupported_terms", "number_order", "no_fact"] as const satisfies readonly BlockedClaimCause[]
/** v1.30.0 (EPIC-0009 D6): at most this many terms are stored and sent; the rest are counted. */
export const BLOCKED_CLAIM_TERMS_LIMIT = 20
/** v1.30.0 (EPIC-0009 D6, OD-4): longest term in UTF-16 code units (`.length`); a longer one is left out and counted. */
export const BLOCKED_CLAIM_TERM_MAX = 120

export const applicationSummarySchema = z
  .object({
    id: z.uuid(),
    jobPostingId: z.uuid(),
    company: z.string().nullable(),
    roleTitle: z.string().nullable(),
    /** v1.27.0: `pasted:<posting id>` for a pasted-description Application; synthetic, never shown. */
    requisitionId: z.string(),
    /** v1.27.0: null for an Application made from a description-only paste (no link). */
    applicationUrl: z.string().nullable(),
    /**
     * v1.27.0 (EPIC-0010 PD-4.4): true when the posting's origin is `pasted_description`
     * (C-PD-51 "Pasted, manual only"; never the Override badge). Required (strict schema).
     */
    pastedDescription: z.boolean(),
    /**
     * v1.27.0 (PD-4.1): true when the posting's apply mode is `manual`: never queued, sampled or
     * submitted automatically. Hide Queue, Make sample and Approve. True for every pasted-description
     * Application. Required (strict schema).
     */
    manualOnly: z.boolean(),
    state: applicationStateSchema,
    /** "Career Profile version {n}" in the Application header; null until documents are generated. */
    careerProfileVersion: z.int().positive().nullable(),
    /** Set with `documents_blocked`: which document was blocked (C-DOC-3 `{resume or cover letter}`). */
    blockedDocument: documentKindSchema.nullable(),
    /** Set with `documents_blocked`: the unsourced claim (C-DOC-3 optional line `Claim: "{claim}"`). */
    blockedClaim: z.string().nullable(),
    /**
     * v1.30.0 (EPIC-0009 D5): why the paragraph in `blockedClaim` was blocked. Today one of
     * BLOCKED_CLAIM_CAUSES. A client must treat any other string as unknown and show the fallback.
     * Absent or null: not blocked, blocked before v1.30.0, or the details were deleted. The api
     * leaves the key out when null.
     */
    blockedClaimCause: z.string().regex(/^[a-z][a-z_]{0,39}$/).nullable().optional(),
    /**
     * v1.30.0 (EPIC-0009 D1, D2a): the flagged words or numbers, exactly as written in the paragraph,
     * in paragraph order, de-duplicated case-insensitively. Sent only with a terms cause
     * (BLOCKED_CLAIM_TERMS_CAUSES). It may be empty. The api leaves the key out when null.
     */
    blockedClaimTerms: z.array(z.string().min(1).max(BLOCKED_CLAIM_TERM_MAX)).max(BLOCKED_CLAIM_TERMS_LIMIT).nullable().optional(),
    /**
     * v1.30.0 (EPIC-0009 D6, OD-4): flagged terms found in the paragraph but not listed, either past the
     * first 20 or longer than 120 units. Present exactly when `blockedClaimTerms` is present. The api
     * leaves the key out when null.
     */
    blockedClaimMoreTerms: z.int().min(0).nullable().optional(),
    failure: documentFailureSchema.nullable(),
    /**
     * Cover letter upload status for C-DOC-1/C-DOC-2. Always `not_submitted` in v1.5.0:
     * submission is slice 5, which sets `uploaded` or `no_field`.
     */
    coverLetterStatus: z.enum(["not_submitted", "uploaded", "no_field"]),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    /**
     * v1.11.0: set when the Candidate deleted the detailed records (AC 10.3). The
     * row is then the minimal record: no documents, answers or Outcomes. Absent
     * or null means the details are present. Show the minimal record view and C-DATA-3.
     */
    detailsDeletedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    /**
     * v1.17.0 (automatic expiry, E5.2, E5.6): the WAT date (`YYYY-MM-DD`) the
     * detailed records are deleted on or after: the creation date one year later
     * (29 Feb goes to 28 Feb), or the launch grace end if later. Null once the
     * details are deleted. Always sent from v1.17.0; optional only so an older
     * api's response still parses.
     */
    expiresOn: z.iso.date().nullable().optional(),
    /**
     * v1.24.0 (AA-4.3 r1): the Candidate override, or null when none is recorded or the details are deleted.
     * `applies` and `notAppliesReason` are computed when the response is built. Required (strict schema).
     */
    override: applicationOverrideSchema.nullable(),
  })
  .strict()
export type ApplicationSummary = z.infer<typeof applicationSummarySchema>

export const applicationDetailSchema = applicationSummarySchema
  .extend({
    /** Only documents that passed validation. A blocked document has no entry and no download. */
    documents: z.array(tailoredDocumentSchema),
    /** v1.24.0 (AA-4.5): the posting's current status and visibility; null when the Candidate no longer holds it or the details are deleted. */
    posting: applicationPostingStateSchema.nullable(),
    /** v1.24.0 (AA-2.5, design B3a): the latest drop from the automatic queue, for C-AA-40 / C-AA-41; null when none applies. */
    latestDrop: latestDropSchema.nullable(),
  })
  .strict()
export type ApplicationDetail = z.infer<typeof applicationDetailSchema>

// v1.28.0: `applicationsResponseSchema` moved to ./application-board.ts (list rows gain the board fields).

export const createApplicationRequestSchema = z
  .object({
    jobPostingId: z.uuid(),
    /** v1.24.0 (AA-2.1): required for an overridable posting; ignored for a ranked one. Absent or null means none. */
    acknowledgement: createApplicationAcknowledgementSchema.nullable().optional(),
  })
  .strict()
export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>

export const createApplicationResponseSchema = z
  .object({
    /** False when an Application already exists for this requisition; the existing one is returned. */
    created: z.boolean(),
    application: applicationSummarySchema,
  })
  .strict()
export type CreateApplicationResponse = z.infer<typeof createApplicationResponseSchema>

export const documentsListRowSchema = z
  .object({
    applicationId: z.uuid(),
    company: z.string().nullable(),
    roleTitle: z.string().nullable(),
    requisitionId: z.string(),
    /** v1.27.0 (PD-4.4, design B4): as `ApplicationSummary.pastedDescription`. Required. */
    pastedDescription: z.boolean(),
    coverLetterStatus: z.enum(["not_submitted", "uploaded", "no_field"]),
    resume: tailoredDocumentSchema.omit({ previewText: true }).nullable(),
    coverLetter: tailoredDocumentSchema.omit({ previewText: true }).nullable(),
  })
  .strict()
export const documentsListResponseSchema = z.object({ rows: z.array(documentsListRowSchema) }).strict()
export type DocumentsListResponse = z.infer<typeof documentsListResponseSchema>

export const CONTACT_LINE_MAX = 120
/** Six, so a resume header can hold a headline, location, phone, email and a profile link (raised from 4). */
export const CONTACT_LINES_LIMIT = 6
export const candidateContactSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    lines: z.array(z.string().trim().min(1).max(CONTACT_LINE_MAX)).max(CONTACT_LINES_LIMIT),
  })
  .strict()
export type CandidateContact = z.infer<typeof candidateContactSchema>

/** v1.26.0 (ATS): the minimum ATS match for automatic submission, 0 to 100; 0 turns the gate off. Default 40. */
export const ATS_MINIMUM_PATH = "/v1/candidate-settings/ats"
export const atsMinimumSchema = z.object({ minAtsPercent: z.int().min(0).max(100) }).strict()
export type AtsMinimum = z.infer<typeof atsMinimumSchema>
