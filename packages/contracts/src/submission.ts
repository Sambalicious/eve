import { z } from "zod"

import { ruleNameSchema } from "./discovery.js"
import { applicationSummarySchema } from "./documents.js"
import { applicationOverrideSchema } from "./override.js"

/** v1.6.0 (slice 5): submission, Activation Gate, daily cap, existing applications. */
export const SUBMISSION_STATUS_PATH = "/v1/submission/status"
export const AUTOMATIC_SUBMISSION_PATH = "/v1/submission/automatic"
export const EXISTING_APPLICATIONS_PATH = "/v1/existing-applications"
export const EXISTING_APPLICATIONS_COMPLETE_PATH = "/v1/existing-applications/complete"
export const sampleRequestPath = (id: string) => `/v1/applications/${id}/sample`
export const sampleApprovePath = (id: string) => `/v1/applications/${id}/sample/approve`
export const sampleRejectPath = (id: string) => `/v1/applications/${id}/sample/reject`
export const queueApplicationPath = (id: string) => `/v1/applications/${id}/queue`
export const markConfirmedPath = (id: string) => `/v1/applications/${id}/mark-confirmed`
export const markNotSubmittedPath = (id: string) => `/v1/applications/${id}/mark-not-submitted`
export const manualCompletePath = (id: string) => `/v1/applications/${id}/manual-complete`
export const sameCompanyApprovePath = (id: string) => `/v1/applications/${id}/same-company/approve`
export const sameCompanyDeclinePath = (id: string) => `/v1/applications/${id}/same-company/decline`
/** v1.24.0 (AA-5): take a queued Application out of the automatic queue. Answers `200 Submission`. */
export const removeFromQueuePath = (id: string) => `/v1/applications/${id}/remove-from-queue`

export const DAILY_AUTOMATIC_CAP = 5
export const REQUIRED_SAMPLES = 5
export const REASON_MAX = 500

export const submissionStateSchema = z.enum([
  /** Waiting for an automatic slot (today or `queuedForWatDay`). */
  "queued",
  /** A slot is claimed and the form is being filled. Nothing has been sent. */
  "submit_claimed",
  /** The backend's single submit click is committed or in flight. */
  "submitting",
  /** Confirmed Submission: confirmation page, application ID, or the Candidate's mark. */
  "confirmed",
  /** Uncertain Submission: submitted, no evidence. Never retried automatically. */
  "uncertain",
  /** Blocked Application: see `blockedReason`. */
  "blocked",
  /** Manual Application: completed by the Candidate. */
  "manual",
  /** The Candidate marked an Uncertain Submission not submitted (sample: no further attempt), or a sample was a duplicate. */
  "not_submitted",
  /** A same-company review the Candidate declined. */
  "declined",
])
export type SubmissionStateValue = z.infer<typeof submissionStateSchema>

/** AC 7.2: the nine Blocked reasons (design-spec C-BLOCK-1 to C-BLOCK-10). */
export const blockedReasonSchema = z.enum([
  "missing_approved_answer",
  "login",
  "email_verification",
  "captcha",
  "assessment",
  "same_company_review",
  "declaration",
  "personal_data_request",
  "automation_incomplete",
  /** v1.26.0 (ATS): an automatic submission held because its resume's ATS match is below the Candidate's minimum. */
  "ats_below_minimum",
])
export type BlockedReasonValue = z.infer<typeof blockedReasonSchema>

/** Sub-reason of `automation_incomplete` (C-BLOCK-10a to 10d); null when none applies. */
export const blockedSubReasonSchema = z.enum(["budget", "redirect", "submit_attempt", "value_mismatch"])

export const submissionSchema = z
  .object({
    /** Null: the Application has not entered submission (documents only, or a sample awaiting review). */
    state: submissionStateSchema.nullable(),
    kind: z.enum(["automatic", "sample"]).nullable(),
    /** 1 for the first attempt, 2 for the fresh attempt after "not submitted" (C-UNC-8). */
    attemptNumber: z.int().nonnegative(),
    submittedAt: z.iso.datetime({ offset: true }).nullable(),
    /** WAT day (YYYY-MM-DD) the submission counts against. */
    submittedWatDay: z.iso.date().nullable(),
    evidence: z
      .object({ kind: z.enum(["confirmation_page", "application_id", "marked_confirmed"]), text: z.string().nullable(), observedAt: z.iso.datetime({ offset: true }) })
      .strict()
      .nullable(),
    captchaAfterSubmit: z.boolean(),
    blockedReason: blockedReasonSchema.nullable(),
    blockedSubReason: blockedSubReasonSchema.nullable(),
    /** The Candidate-facing detail line, quoting the form's label (C-BLOCK-*), or null. Never an Approved Answer value. */
    blockedDetail: z.string().nullable(),
    /** v1.7.0: with `missing_approved_answer`, the question exactly as the form asked it (C-BLOCK-1); otherwise null. */
    blockedQuestion: z.string().nullable(),
    blockedAt: z.iso.datetime({ offset: true }).nullable(),
    /** Set when the cap refused today's slot: the WAT day it is queued for (C-CAP-3). */
    queuedForWatDay: z.iso.date().nullable(),
    sample: z
      .object({
        state: z.enum(["awaiting_review", "approved", "rejected"]),
        rejectReason: z.string().nullable(),
        /** True once it reached Confirmed or Uncertain Submission; false again after "not submitted". */
        counts: z.boolean(),
      })
      .strict()
      .nullable(),
    declinedReason: z.string().nullable(),
    /** v1.7.0: when the same-company review was declined (C-BLOCK-12a, 12d, 13). */
    declinedAt: z.iso.datetime({ offset: true }).nullable(),
    /** v1.7.0: when the Candidate last marked an Uncertain Submission not submitted (C-UNC-6, C-UNC-10, C-SAMPLE-12). */
    markedNotSubmittedAt: z.iso.datetime({ offset: true }).nullable(),
    manualCompletedAt: z.iso.datetime({ offset: true }).nullable(),
    /** v1.24.0 (AA-4.3 r1): the same override object as `ApplicationSummary.override`. Required (strict schema). */
    override: applicationOverrideSchema.nullable(),
  })
  .strict()
export type Submission = z.infer<typeof submissionSchema>

export const submissionStatusSchema = z
  .object({
    automaticEnabled: z.boolean(),
    gatePassedAt: z.iso.datetime({ offset: true }).nullable(),
    careerProfileApproved: z.boolean(),
    existingApplicationsCompletedAt: z.iso.datetime({ offset: true }).nullable(),
    /** Samples counting toward the five (C-GATE-3, C-GATE-5). */
    countingSamples: z.int().nonnegative(),
    requiredSamples: z.literal(REQUIRED_SAMPLES),
    todayWatDay: z.iso.date(),
    /** Automatic submissions counted against today (may exceed the cap after a late confirmation, C-CAP-7). */
    todayCount: z.int().nonnegative(),
    cap: z.literal(DAILY_AUTOMATIC_CAP),
    queuedForTomorrow: z.int().nonnegative(),
    globalPaused: z.boolean(),
  })
  .strict()
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>

export const setAutomaticRequestSchema = z.object({ enabled: z.boolean() }).strict()

export const reasonRequestSchema = z.object({ reason: z.string() }).strict()

/**
 * POST sample/approve result (C-SAMPLE-1 to C-SAMPLE-5). `alreadyDone` is true when a second request found the first result.
 * v1.8.0 (F-QA5-01): the api records the approval and hands the sample to the worker, so a fresh approval answers
 * `pending`. Poll `GET /v1/applications/{id}/submission` until `state` is set (the outcome) or `sample.state` is
 * `awaiting_review` again (nothing was sent: C-SAMPLE-13). `not_submitted` now means automation was paused at approval.
 */
export const sampleResultSchema = z
  .object({
    /**
     * v1.24.0 (AA-3.2): `not_ranked` (posting not ranked, not excluded: C-AA-36 then C-SAMPLE-10) and
     * `not_allowed` (an override is recorded: C-AA-37 then C-SAMPLE-10). Neither sends anything or counts.
     */
    result: z.enum(["pending", "confirmed", "uncertain", "blocked", "excluded", "duplicate", "held", "not_submitted", "not_ranked", "not_allowed"]),
    alreadyDone: z.boolean(),
    countingSamples: z.int().nonnegative(),
    gatePassedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
export type SampleResult = z.infer<typeof sampleResultSchema>

export const existingApplicationSchema = z
  .object({
    id: z.uuid(),
    company: z.string(),
    roleTitle: z.string(),
    applicationUrl: z.string(),
    requisitionId: z.string().nullable(),
    appliedOn: z.iso.date(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type ExistingApplication = z.infer<typeof existingApplicationSchema>

/** Field checks in order; the first empty field gives its C-VAL-EXIST-1 message as `existing_application_field_empty`. */
export const createExistingApplicationRequestSchema = z
  .object({
    company: z.string(),
    roleTitle: z.string(),
    applicationUrl: z.string(),
    requisitionId: z.string().nullable().optional(),
    appliedOn: z.string(),
  })
  .strict()
export type CreateExistingApplicationRequest = z.infer<typeof createExistingApplicationRequestSchema>

export const existingApplicationsResponseSchema = z
  .object({ applications: z.array(existingApplicationSchema), completedAt: z.iso.datetime({ offset: true }).nullable() })
  .strict()
export type ExistingApplicationsResponse = z.infer<typeof existingApplicationsResponseSchema>

export const createExistingApplicationResponseSchema = z.object({ created: z.boolean(), application: existingApplicationSchema }).strict()

/**
 * v1.6.1: `GET /v1/submissions?view=…`, one request for the Blocked, Uncertain
 * and same-company review lists (each row has the Application summary and its
 * Submission), so the dashboard does not fetch `…/submission` per row.
 */
export const SUBMISSIONS_PATH = "/v1/submissions"
export const submissionListViewSchema = z.enum([
  /** Blocked Applications except same-company review holds. */
  "blocked",
  /** Uncertain Submissions. */
  "uncertain",
  /** Same-company review holds (`blockedReason: same_company_review`). */
  "held",
  /** All three, for the dashboard's attention list. */
  "attention",
])
export type SubmissionListView = z.infer<typeof submissionListViewSchema>
export const submissionsPath = (view: SubmissionListView) => `${SUBMISSIONS_PATH}?view=${view}`

export const submissionListRowSchema = z.object({ application: applicationSummarySchema, submission: submissionSchema }).strict()
export type SubmissionListRow = z.infer<typeof submissionListRowSchema>
export const submissionListResponseSchema = z.object({ rows: z.array(submissionListRowSchema) }).strict()
export type SubmissionListResponse = z.infer<typeof submissionListResponseSchema>

/**
 * v1.7.0: Activation Gate samples. `POST /v1/samples/prepare` makes eligible,
 * strong-Match, ranked Applications with ready documents into samples awaiting
 * review, only as many as the five still need (the worker also runs it daily).
 * `GET /v1/samples?state=…` lists them with what each row shows (design F2 step 2).
 */
export const SAMPLES_PATH = "/v1/samples"
export const SAMPLES_PREPARE_PATH = "/v1/samples/prepare"
export const sampleStateSchema = z.enum(["awaiting_review", "approved", "rejected"])
export type SampleStateValue = z.infer<typeof sampleStateSchema>
export const samplesPath = (state: SampleStateValue) => `${SAMPLES_PATH}?state=${state}`

export const sampleRowSchema = z
  .object({
    application: applicationSummarySchema,
    submission: submissionSchema,
    applicationSystem: z.string(),
    /** Match summary (C-MATCH-2); null when the posting has no Match on record. */
    match: z.object({ coveredCount: z.int().nonnegative(), totalCount: z.int().nonnegative() }).strict().nullable(),
    unverifiedLabels: z.array(ruleNameSchema),
  })
  .strict()
export type SampleRow = z.infer<typeof sampleRowSchema>
export const samplesResponseSchema = z.object({ rows: z.array(sampleRowSchema) }).strict()
export type SamplesResponse = z.infer<typeof samplesResponseSchema>

/** Why preparation added fewer samples than the five need (null when it added what was needed or nothing was needed). */
export const prepareSamplesResultSchema = z
  .object({
    created: z.int().nonnegative(),
    stoppedBy: z.enum(["gate_passed", "paused", "career_profile_not_approved", "no_candidates"]).nullable(),
  })
  .strict()
export type PrepareSamplesResult = z.infer<typeof prepareSamplesResultSchema>

/** v1.7.0: `GET /v1/submissions/summary`, one request for Home's Needs you list and the sidebar badges. */
export const SUBMISSIONS_SUMMARY_PATH = "/v1/submissions/summary"
export const submissionSummarySchema = z
  .object({
    samples: z.object({ awaitingReview: z.int().nonnegative(), approved: z.int().nonnegative(), rejected: z.int().nonnegative() }).strict(),
    /** Blocked Applications except same-company review holds. */
    blocked: z.int().nonnegative(),
    held: z.int().nonnegative(),
    uncertain: z.int().nonnegative(),
  })
  .strict()
export type SubmissionSummary = z.infer<typeof submissionSummarySchema>

/**
 * v1.7.0: `GET /v1/applications/{id}/form-answers`, what the form will receive
 * (C-SAMPLE-14 to 17), planned by the same backend answer assignment the
 * submission uses. Read from the live form only in the worker; the api returns
 * the plan recorded when the form was last read, or `available: false`.
 */
export const formAnswerSourceSchema = z.enum([
  "approved_answer_standard",
  "approved_answer_custom",
  "approved_answer_skill",
  "approved_answer_sensitive",
  "salary_gross_policy",
  "salary_current",
  "settings_contact",
  "settings_location",
  "settings_work_authorization",
  "rule_sponsorship",
  "document_resume",
  "document_cover_letter",
  /** A required question no Approved Answer covers (shown as "No Approved Answer"). */
  "missing",
])
export type FormAnswerSource = z.infer<typeof formAnswerSourceSchema>
export const formAnswerSchema = z
  .object({
    /** The question exactly as the form asks it. */
    question: z.string(),
    source: formAnswerSourceSchema,
    /** Null when `redacted` (sensitive), for a document, or when the field blocks. */
    value: z.string().nullable(),
    redacted: z.boolean(),
    /** Set when this field blocks submission (`source: missing`): the Blocked reason it would get. */
    blockedReason: blockedReasonSchema.nullable(),
    /**
     * v1.11.0 (CR5E-01): true when no Approved Answer can ever fill this field (a work-authorization
     * question read from the page). Offer only the Manual Application path, not "Add Approved Answer".
     * Absent otherwise.
     */
    manualOnly: z.literal(true).optional(),
  })
  .strict()
export type FormAnswer = z.infer<typeof formAnswerSchema>
export const formAnswersResponseSchema = z
  .object({
    /** False until the worker has read this Application's form; the panel then has no rows to show. */
    available: z.boolean(),
    readAt: z.iso.datetime({ offset: true }).nullable(),
    answers: z.array(formAnswerSchema),
  })
  .strict()
export type FormAnswersResponse = z.infer<typeof formAnswersResponseSchema>
export const formAnswersPath = (id: string) => `/v1/applications/${id}/form-answers`

/** v1.24.0 (AA-5): `POST /v1/applications/{id}/remove-from-queue` answers the current Submission (state null after a removal). */
export const removeFromQueueResponseSchema = submissionSchema
export type RemoveFromQueueResponse = Submission

/** v1.24.0: `submission_event.kind` values the API writes. Free text in the database; this is the vocabulary. */
export const submissionEventKindSchema = z.enum([
  "automatic_refused_gate_not_passed",
  "browser_unavailable",
  "post_submit_off_origin",
  "queued_posting_dropped",
  "queue_removed",
  "sample_posting_dropped",
])
export type SubmissionEventKind = z.infer<typeof submissionEventKindSchema>

/** v1.24.0 (AA-3.3): `detail` of a `sample_posting_dropped` event. */
export const samplePostingDroppedDetailSchema = z.enum(["not_ranked", "hidden", "override"])
export type SamplePostingDroppedDetail = z.infer<typeof samplePostingDroppedDetailSchema>
