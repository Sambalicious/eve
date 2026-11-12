/** Application and its Tailored Documents as the dashboard uses them (CONTEXT.md: Application, Tailored Document). */

import type { BlockedClaimCause } from "@eve/contracts"

export type ApplicationState = "prepared" | "generating" | "documents_ready" | "documents_blocked" | "documents_failed"

export type DocumentKind = "resume" | "cover_letter"

export type DocumentFailure =
  | "not_approved"
  | "not_configured"
  | "provider_error"
  | "invalid_output"
  | "timed_out"
  | "no_career_profile"
  | "render_check_failed"
  | "storage_error"
  | "interrupted"

export type CoverLetterStatus = "not_submitted" | "uploaded" | "no_field"

export interface DocumentFiles {
  readonly kind: DocumentKind
  readonly careerProfileVersion: number
  readonly createdAt: string
  /** Same-origin `/v1/...` paths. */
  readonly pdfUrl: string
  readonly docxUrl: string
  /** ATS match against the posting's keywords; resumes written since ATS scoring only, else null. */
  readonly ats: AtsMatch | null
}

/** A resume's ATS match: score 0 to 100, requirements met out of `total`, and the keyword lists. */
export interface AtsMatch {
  readonly score: number
  readonly total: number
  readonly matched: readonly string[]
  readonly missing: readonly string[]
  readonly gaps: readonly string[]
}

export interface TailoredDocument extends DocumentFiles {
  /** Rendered text in reading order, for the accessible text preview. */
  readonly previewText: readonly string[]
}

/** v1.24.0 (AA-4.3 r1): the Candidate override on an Application. Stored fields are null for a legacy override. */
export interface ApplicationOverride {
  readonly createdAt: string
  readonly status: "skipped" | "excluded" | null
  readonly skipReason: string | null
  readonly skipDetail: string | null
  readonly violatedRules: readonly string[] | null
  readonly applies: boolean
  readonly notAppliesReason: "hidden" | "legacy_no_decision" | "decision_changed" | null
}

/** Outcome types that place a card on the board (`request_for_action` never moves one). */
export type BoardOutcomeType = "confirmation" | "rejection" | "interview_invitation" | "offer"

/**
 * Read-only board fields from `GET /v1/applications` only (contract v1.28.0 C4); absent on
 * detail, create and the other Application routes.
 */
export interface BoardInfo {
  readonly submissionState:
    | "queued" | "submit_claimed" | "submitting" | "confirmed" | "uncertain" | "blocked" | "manual" | "not_submitted" | "declined"
    | null
  readonly submissionKind: "automatic" | "sample" | null
  readonly sampleState: "awaiting_review" | "approved" | "rejected" | null
  readonly latestOutcome: { readonly id: string; readonly type: BoardOutcomeType; readonly createdAt: string } | null
  readonly requestForAction: boolean
}

export interface Application {
  /** Only on list rows. */
  readonly board?: BoardInfo
  readonly id: string
  readonly jobPostingId: string
  readonly company: string | null
  readonly roleTitle: string | null
  /** v1.27.0: synthetic `pasted:<posting id>` when `pastedDescription`; never shown then. */
  readonly requisitionId: string
  /** v1.27.0: null for a description-only paste (no link). */
  readonly applicationUrl: string | null
  /** v1.27.0 (PD-4.4): made from a pasted description (C-PD-51; never Override). */
  readonly pastedDescription: boolean
  /** v1.27.0 (PD-4.1): never queued, sampled or submitted; no queue or sample actions. */
  readonly manualOnly: boolean
  readonly state: ApplicationState
  readonly careerProfileVersion: number | null
  readonly blocked: {
    readonly document: DocumentKind
    readonly claim: string | null
    /** v1.30.0 (EPIC-0009): why it was blocked; null on a row blocked before this release or an unknown cause. */
    readonly cause: BlockedClaimCause | null
    /** Only for a cause that shows a list, and only as written in the claim. Null for every other cause. */
    readonly terms: readonly string[] | null
    /** Flagged terms not listed, either past the cap or longer than the contract allows. */
    readonly moreTerms: number | null
  } | null
  readonly failure: DocumentFailure | null
  readonly coverLetterStatus: CoverLetterStatus
  readonly createdAt: string
  /** Last change to the row. */
  readonly updatedAt: string
  /** Set once the Candidate deleted the detailed records (AC 10.3): the row is then the minimal record. */
  readonly detailsDeletedAt: string | null
  /**
   * v1.17.0 (E5.2): the WAT date (`YYYY-MM-DD`) automatic expiry deletes the
   * detailed records on. Null once they are deleted; undefined when an older
   * api did not send it ("unknown", not "deleted").
   */
  readonly expiresOn: string | null | undefined
  /** v1.24.0: null when no override is recorded or the details are deleted. */
  readonly override: ApplicationOverride | null
}

export interface ApplicationDetail extends Application {
  readonly documents: readonly TailoredDocument[]
  /** v1.24.0 (AA-4.5): the posting's current status and visibility; null when not held or details deleted. */
  readonly posting: { readonly status: string; readonly hidden: boolean } | null
  /** v1.24.0 (B3a): the latest drop from the automatic queue, for C-AA-40 / C-AA-41. */
  readonly latestDrop: { readonly at: string; readonly reason: "closed" | "not_submittable" } | null
}

export interface DocumentsListRow {
  readonly applicationId: string
  readonly company: string | null
  readonly roleTitle: string | null
  readonly requisitionId: string
  /** v1.27.0 (B4): C-PD-51 in the badge slot; the requisition cell renders empty. */
  readonly pastedDescription: boolean
  readonly coverLetterStatus: CoverLetterStatus
  readonly resume: DocumentFiles | null
  readonly coverLetter: DocumentFiles | null
}

/** "Senior Frontend Engineer at Acme", falling back to whichever part exists, then the requisition ID. */
export function applicationName(app: Pick<Application, "roleTitle" | "company" | "requisitionId">): string {
  if (app.roleTitle && app.company) return `${app.roleTitle} at ${app.company}`
  return app.roleTitle ?? app.company ?? app.requisitionId
}

/** Same-origin download path of a Tailored Document (api-contract v1.5.0). */
export function documentDownloadUrl(id: string, kind: DocumentKind, format: "pdf" | "docx"): string {
  return `/v1/applications/${encodeURIComponent(id)}/documents/${kind === "resume" ? "resume" : "cover-letter"}.${format}`
}
