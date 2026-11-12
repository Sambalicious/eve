import { z } from "zod"

import { accessRequestFieldCodeSchema } from "./access-request.js"
import { pasteFieldErrorSchema } from "./discovery.js"
import { fieldErrorSchema } from "./job-criteria.js"
import { convertedFeatureSchema } from "./me.js"
import { preferencesFieldErrorSchema } from "./preferences.js"
import { stackPostsFieldErrorSchema } from "./stack-posts.js"

/** Machine-readable error codes returned by every /v1 endpoint. */
export const apiErrorCodeSchema = z.enum([
  "unauthenticated",
  "session_expired",
  "csrf_invalid",
  "not_found",
  "service_unavailable",
  "internal_error",
  // v1.1.0: client errors (CR-05, SEC-006)
  "bad_request",
  "unsupported_media_type",
  "payload_too_large",
  // v1.1.0: AI provider, Career Profile, Approved Answers
  "ai_provider_not_approved",
  "resume_file_invalid",
  "resume_unreadable",
  "resume_drafting_in_progress",
  // v1.2.0: QA-F2
  "resume_storage_unavailable",
  "career_profile_draft_exists",
  "ai_provider_not_configured",
  "career_profile_fact_empty",
  "approved_answer_value_empty",
  "approved_answer_question_empty",
  "approved_answer_exists",
  // v1.4.0: slice 3 discovery
  "job_link_empty",
  "job_link_invalid",
  "job_source_not_verified",
  "job_source_unavailable",
  // v1.5.0: slice 4 Tailored Documents
  "application_not_eligible",
  "contact_details_missing",
  "document_not_available",
  // v1.6.0: slice 5 submission and the Activation Gate
  "reason_empty",
  "existing_application_company_empty",
  "existing_application_role_empty",
  "existing_application_url_empty",
  "existing_application_date_empty",
  "gate_requirements_unmet",
  "not_a_sample",
  "application_state_conflict",
  "automation_incomplete_not_requeueable",
  "posting_declined",
  // v1.9.0: SEC-507 / F-QA5B-01
  "gate_passed",
  // v1.14.0: EPIC-0005 Stack posts
  "alert_feeds_not_verified",
  // v1.15.0: SEC-006 (EPIC-0004), sent with a Retry-After header
  "too_many_requests",
  // v1.16.0: EPIC-0003 public request access
  "origin_forbidden",
  "access_request_invalid",
  "rate_limited_ip",
  "rate_limited_global",
  // v1.18.0: EPIC-0006 hidden postings
  "posting_hidden",
  // v1.21.0: EPIC-0002 A2, a route behind ConvertedFeatureGuard before its converting slice
  "feature_not_yet_available",
  // v1.24.0: apply anyway, bounds and consent (copy C-AA-10, C-AA-12, C-AA-9, C-AA-11, C-AA-37)
  "override_not_allowed",
  "override_acknowledgement_missing",
  "override_decision_changed",
  "override_application_state",
  "sample_not_allowed",
  // v1.25.0: EPIC-0002 B1 Job Preferences
  "preferences_stale",
  "timezone_change_rate_limited",
  // v1.27.0: EPIC-0010 pasted job descriptions (POST /v1/job-postings/links; 422 unless noted)
  "job_description_too_short",
  "job_description_too_long",
  "job_title_required",
  "job_title_too_long",
  "company_required",
  "company_too_long",
  "employer_page_unreadable",
  /** 409 */
  "posting_still_checking",
  /** 409, on POST …/queue, …/sample and …/sample/approve for a manual-only Application */
  "manual_application_only",
  // v1.28.0: EPIC-0011 PUT /v1/me/advanced (409)
  "advanced_locked",
  // v1.31.0: EPIC-0014 outreach (422)
  "outreach_reader_name_invalid",
])
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>

/**
 * Why a resume was refused with `resume_unreadable` (v1.3.0, Candidate decision
 * 2026-10-18). The dashboard picks C-PROFILE-4a (`pages`), 4b (`characters`), 4c
 * (`docx_limits`), 4d (`parse_limits`) or C-PROFILE-4 (`no_text`).
 */
export const resumeRefusalReasonSchema = z.enum(["pages", "characters", "docx_limits", "parse_limits", "no_text"])
export type ResumeRefusalReason = z.infer<typeof resumeRefusalReasonSchema>

/**
 * The single error envelope used across the API. It never carries domain data.
 * `reason` is present only on `resume_unreadable` (v1.3.0) and names a limit,
 * never file content. `fieldErrors` (v1.13.0) is present only on `bad_request`
 * from `PUT /v1/candidate-settings/job-criteria` and never echoes a value.
 * v1.14.0: `fieldErrors` is also present on `bad_request` from the Stack posts
 * routes, with the `stackPostsFieldErrorSchema` shape.
 * `fields` (v1.16.0) is present only on `access_request_invalid` and lists field
 * codes, never submitted values.
 * `feature` (v1.21.0) is present only on `feature_not_yet_available` and names
 * the unconverted feature the route belongs to.
 * v1.25.0: `fieldErrors` is also present on `bad_request` from `PUT /v1/me/preferences`,
 * with the `preferencesFieldErrorSchema` shape. `currentVersion` is present only on
 * `preferences_stale` (null when the Candidate has no record), and `timeZoneLockedUntil`
 * only on `timezone_change_rate_limited`.
 * v1.27.0: `fieldErrors` is also present, with the `pasteFieldErrorSchema` shape, on the six
 * paste field codes (`job_description_*`, `job_title_*`, `company_*`) and on `employer_page_unreadable`.
 */
export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string(),
        reason: resumeRefusalReasonSchema.optional(),
        fields: z.array(accessRequestFieldCodeSchema).optional(),
        fieldErrors: z.array(z.union([fieldErrorSchema, stackPostsFieldErrorSchema, preferencesFieldErrorSchema, pasteFieldErrorSchema])).min(1).optional(),
        feature: convertedFeatureSchema.optional(),
        currentVersion: z.int().positive().nullable().optional(),
        timeZoneLockedUntil: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
  })
  .strict()
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>
/** v1.14.0: any field-level error the envelope can carry. */
export type ApiFieldError = NonNullable<ApiErrorResponse["error"]["fieldErrors"]>[number]

/**
 * v1.24.0: the exact messages of the apply-anyway codes, byte for byte from
 * `copy-deck-apply-anyway.md` (keys `api.error.*`). The api sends these; the web
 * and its MSW handlers import them instead of retyping prose.
 */
export const APPLY_ANYWAY_ERROR_MESSAGES = {
  override_not_allowed: "This posting's reason can't be overridden. Nothing changed.",
  override_acknowledgement_missing: "Confirm the override in its dialog first. Nothing changed. Reload the page and try again.",
  override_decision_changed: "This posting's decision changed after you opened the dialog, so your override wasn't recorded. Review its new reason, then try again.",
  override_application_state: "The Application for this requisition is past the point where you can record an override. Nothing changed. Open it from Applications.",
  sample_not_allowed: "An Application with an override, or for a Job Posting that isn't ranked, can't be an Activation Gate sample. Nothing changed.",
} as const satisfies Partial<Record<ApiErrorCode, string>>

/**
 * v1.27.0 (EPIC-0010): the exact messages of the paste codes, byte for byte from the copy deck
 * (`copy-deck.md`, slots in comments). The api sends these; the web and its MSW handlers import
 * them. `manual_application_only` has no copy slot: the UI never offers those actions.
 */
export const PASTE_DESCRIPTION_ERROR_MESSAGES = {
  /** C-PD-21 */
  job_description_too_short: "Too short to check. Paste the full description, at least 200 characters.",
  /** C-PD-22 */
  job_description_too_long: "Over the 30,000-character limit. Shorten it to check this job.",
  /** C-PD-23 */
  job_title_required: "Enter the job title.",
  /** C-PD-25 */
  job_title_too_long: "Job title is over 200 characters. Shorten it.",
  /** C-PD-24 */
  company_required: "Enter the company.",
  /** C-PD-25b */
  company_too_long: "Company is over 200 characters. Shorten it.",
  /** C-PD-27 */
  employer_page_unreadable: "Eve couldn't read the employer's page. Enter the Job title and Company to use your description.",
  /** C-PD-28 */
  posting_still_checking: "Eve is still checking your earlier description for this job. Try again when that finishes.",
  manual_application_only: "This Application is manual only. Eve never sends it, so it can't be queued or used as a sample. Nothing changed.",
} as const satisfies Partial<Record<ApiErrorCode, string>>

/** v1.28.0 (EPIC-0011): the exact message of `advanced_locked`. The api sends it; MSW handlers import it. */
export const ADVANCED_ERROR_MESSAGES = {
  advanced_locked: "Advanced stays on while automatic applying is on. Turn off automatic applying first.",
} as const satisfies Partial<Record<ApiErrorCode, string>>

/** v1.27.0: the message for each paste field problem, as the web shows it on that field. */
export const PASTE_FIELD_MESSAGES = {
  description: { too_short: PASTE_DESCRIPTION_ERROR_MESSAGES.job_description_too_short, too_long: PASTE_DESCRIPTION_ERROR_MESSAGES.job_description_too_long },
  title: { required: PASTE_DESCRIPTION_ERROR_MESSAGES.job_title_required, too_long: PASTE_DESCRIPTION_ERROR_MESSAGES.job_title_too_long },
  company: { required: PASTE_DESCRIPTION_ERROR_MESSAGES.company_required, too_long: PASTE_DESCRIPTION_ERROR_MESSAGES.company_too_long },
} as const
