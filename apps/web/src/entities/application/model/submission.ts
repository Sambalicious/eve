import type { RuleNameValue } from "@eve/contracts"
/**
 * Submission of an Application as the dashboard uses it (CONTEXT.md:
 * Confirmed Submission, Uncertain Submission, Blocked Application, Manual
 * Application, Activation Gate). Mapped from the contract's `Submission`.
 */
import type { Application, ApplicationOverride } from "./application"

export type SubmissionState =
  | "queued"
  | "submit_claimed"
  | "submitting"
  | "confirmed"
  | "uncertain"
  | "blocked"
  | "manual"
  | "not_submitted"
  | "declined"

export type BlockedReason =
  | "missing_approved_answer"
  | "login"
  | "email_verification"
  | "captcha"
  | "assessment"
  | "same_company_review"
  | "declaration"
  | "personal_data_request"
  | "automation_incomplete"
  | "ats_below_minimum"

export type BlockedSubReason = "budget" | "redirect" | "submit_attempt" | "value_mismatch"

export type EvidenceKind = "confirmation_page" | "application_id" | "marked_confirmed"

export type SampleState = "awaiting_review" | "approved" | "rejected"

export interface Submission {
  readonly state: SubmissionState | null
  readonly kind: "automatic" | "sample" | null
  readonly attemptNumber: number
  readonly submittedAt: string | null
  readonly submittedWatDay: string | null
  readonly evidence: { readonly kind: EvidenceKind; readonly text: string | null; readonly observedAt: string } | null
  readonly captchaAfterSubmit: boolean
  readonly blocked: {
    readonly reason: BlockedReason
    readonly subReason: BlockedSubReason | null
    /** The backend's detail line, quoting the form's own label. */
    readonly detail: string | null
    /** Missing Approved Answer only: the question exactly as the form asked it (C-BLOCK-1). */
    readonly question: string | null
    readonly at: string | null
  } | null
  readonly queuedForWatDay: string | null
  readonly sample: { readonly state: SampleState; readonly rejectReason: string | null; readonly counts: boolean } | null
  readonly declinedReason: string | null
  /** When the same-company review was declined; a second decline keeps the first date (C-BLOCK-12a, 12d, 13). */
  readonly declinedAt: string | null
  /** When the Candidate last marked it not submitted (C-UNC-6, C-UNC-10, C-SAMPLE-12). */
  readonly markedNotSubmittedAt: string | null
  readonly manualCompletedAt: string | null
  /** v1.24.0: the same override object as the Application's. */
  readonly override: ApplicationOverride | null
}

export interface SubmissionStatus {
  readonly automaticEnabled: boolean
  readonly gatePassedAt: string | null
  readonly careerProfileApproved: boolean
  readonly existingApplicationsCompletedAt: string | null
  readonly countingSamples: number
  readonly requiredSamples: number
  readonly todayWatDay: string
  readonly todayCount: number
  readonly cap: number
  readonly queuedForTomorrow: number
  readonly globalPaused: boolean
}

/** v1.8.0: `pending` means the approval is recorded and the worker is submitting; poll the Submission for the outcome. */
export type SampleResultKind =
  | "pending"
  | "confirmed"
  | "uncertain"
  | "blocked"
  | "excluded"
  | "duplicate"
  | "held"
  | "not_submitted"
  /** v1.24.0 (AA-3.2): the posting isn't ranked and isn't excluded (C-AA-36). */
  | "not_ranked"
  /** v1.24.0 (AA-3.2): an override is recorded (C-AA-37). */
  | "not_allowed"

export interface SampleResult {
  readonly result: SampleResultKind
  readonly alreadyDone: boolean
  readonly countingSamples: number
  readonly gatePassedAt: string | null
}

/**
 * An approved sample the worker hasn't finished (v1.8.0): approved with no
 * submission state yet (`pending`), or claimed or submitting.
 */
export function isSampleSubmitting(s: Submission): boolean {
  if (s.state === "submit_claimed" || s.state === "submitting") return true
  return s.state === null && s.sample?.state === "approved"
}

/**
 * The approval result a Submission now stands for, after an approval answered
 * `pending` (api-contract v1.8.0): the worker's outcome, or `not_submitted`
 * when the sample is back in awaiting review (C-SAMPLE-13). Null while the
 * worker hasn't finished. A sample refused as a duplicate ends `not_submitted`
 * while still approved (C-SAMPLE-4).
 */
export function settledSampleResult(s: Submission): Exclude<SampleResultKind, "pending" | "excluded"> | null {
  if (s.state === null) return s.sample?.state === "awaiting_review" ? "not_submitted" : null
  switch (s.state) {
    case "confirmed":
    case "uncertain":
      return s.state
    case "blocked":
      return s.blocked?.reason === "same_company_review" ? "held" : "blocked"
    case "not_submitted":
      return s.sample?.state === "awaiting_review" ? "not_submitted" : "duplicate"
    default:
      return null
  }
}

export type SubmissionListView = "blocked" | "uncertain" | "held" | "attention"

/** One row of the Blocked, Uncertain or same-company lists. */
export interface SubmissionRow {
  readonly application: Application
  readonly submission: Submission
}

/** What the gate still needs, in C-GATE-3's order. */
export type GateRequirement = { kind: "career_profile" } | { kind: "existing_applications" } | { kind: "samples"; missing: number }

export function missingGateRequirements(status: SubmissionStatus): GateRequirement[] {
  const missing: GateRequirement[] = []
  if (!status.careerProfileApproved) missing.push({ kind: "career_profile" })
  if (status.existingApplicationsCompletedAt === null) missing.push({ kind: "existing_applications" })
  const samples = Math.max(0, status.requiredSamples - status.countingSamples)
  if (samples > 0) missing.push({ kind: "samples", missing: samples })
  return missing
}

/**
 * Which Approved Answer a Missing Approved Answer block needs (F6, FE5-4):
 * a Custom question for C-BLOCK-1, the Sensitive section for C-BLOCK-1a, the
 * Salary section for C-BLOCK-1b and 1c. The backend states which form it
 * used only in the detail line, so this reads the line's fixed opening or
 * ending; the question itself comes from `blockedQuestion`.
 */
export type MissingAnswerTarget =
  | { readonly kind: "custom"; readonly question: string }
  | { readonly kind: "sensitive" }
  | { readonly kind: "salary" }

export function missingAnswerTarget(blocked: NonNullable<Submission["blocked"]>): MissingAnswerTarget | null {
  if (blocked.reason !== "missing_approved_answer") return null
  const detail = blocked.detail ?? ""
  if (detail.startsWith("The form asks a sensitive question")) return { kind: "sensitive" }
  if (detail.startsWith("The form asks for your current salary") || detail.endsWith("which your gross-salary policy doesn't cover.")) return { kind: "salary" }
  return blocked.question ? { kind: "custom", question: blocked.question } : null
}

/** One Activation Gate sample row (F2 step 2). */
export interface SampleRow {
  readonly application: Application
  readonly submission: Submission
  readonly applicationSystem: string
  /** Match summary for C-MATCH-2; null when the posting has no Match on record. */
  readonly match: { readonly covered: number; readonly total: number } | null
  readonly unverifiedLabels: readonly RuleNameValue[]
}

/** Home's Needs you list and the sidebar badges, in one request. */
export interface SubmissionSummary {
  readonly samples: { readonly awaitingReview: number; readonly approved: number; readonly rejected: number }
  /** Blocked Applications except same-company review holds. */
  readonly blocked: number
  readonly held: number
  readonly uncertain: number
}

export interface PrepareSamplesResult {
  readonly created: number
  readonly stoppedBy: "gate_passed" | "paused" | "career_profile_not_approved" | "no_candidates" | null
}

export type FormAnswerSource =
  | "approved_answer_standard"
  | "approved_answer_custom"
  | "approved_answer_skill"
  | "approved_answer_sensitive"
  | "salary_gross_policy"
  | "salary_current"
  | "settings_contact"
  | "settings_location"
  | "settings_work_authorization"
  | "rule_sponsorship"
  | "document_resume"
  | "document_cover_letter"
  | "missing"

/** One planned answer, in form order (C-SAMPLE-14 to 17). */
export interface FormAnswer {
  readonly question: string
  readonly source: FormAnswerSource
  /** Null when redacted, for a document, or when the field blocks. */
  readonly value: string | null
  readonly redacted: boolean
  readonly blockedReason: BlockedReason | null
  /** CR5E-01: no Approved Answer can ever fill this field (a work question read from the page); only the Manual Application path applies. */
  readonly manualOnly: boolean
}

/** False `available`: the worker hasn't read this form yet, so there is no plan to show. */
export interface FormAnswers {
  readonly available: boolean
  readonly answers: readonly FormAnswer[]
}
