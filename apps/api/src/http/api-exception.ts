import { HttpException, HttpStatus } from "@nestjs/common"
import type { AccessRequestFieldCode, ApiErrorCode, ApiFieldError, ConvertedFeature, PasteFieldError, ResumeRefusalReason } from "@eve/contracts"
import { ADVANCED_ERROR_MESSAGES, APPLY_ANYWAY_ERROR_MESSAGES, OUTREACH_ERROR_MESSAGES, PASTE_DESCRIPTION_ERROR_MESSAGES, pasteFieldErrorCode } from "@eve/contracts"

const STATUS_BY_CODE: Record<ApiErrorCode, HttpStatus> = {
  unauthenticated: HttpStatus.UNAUTHORIZED,
  session_expired: HttpStatus.UNAUTHORIZED,
  csrf_invalid: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  service_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  internal_error: HttpStatus.INTERNAL_SERVER_ERROR,
  bad_request: HttpStatus.BAD_REQUEST,
  unsupported_media_type: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  payload_too_large: HttpStatus.PAYLOAD_TOO_LARGE,
  ai_provider_not_approved: HttpStatus.CONFLICT,
  resume_file_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  resume_unreadable: HttpStatus.UNPROCESSABLE_ENTITY,
  resume_drafting_in_progress: HttpStatus.CONFLICT,
  resume_storage_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  career_profile_draft_exists: HttpStatus.CONFLICT,
  ai_provider_not_configured: HttpStatus.SERVICE_UNAVAILABLE,
  career_profile_fact_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  approved_answer_value_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  approved_answer_question_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  approved_answer_exists: HttpStatus.CONFLICT,
  job_link_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  job_link_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  job_source_not_verified: HttpStatus.CONFLICT,
  job_source_unavailable: HttpStatus.CONFLICT,
  application_not_eligible: HttpStatus.CONFLICT,
  contact_details_missing: HttpStatus.CONFLICT,
  document_not_available: HttpStatus.NOT_FOUND,
  reason_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  existing_application_company_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  existing_application_role_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  existing_application_url_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  existing_application_date_empty: HttpStatus.UNPROCESSABLE_ENTITY,
  gate_requirements_unmet: HttpStatus.CONFLICT,
  not_a_sample: HttpStatus.CONFLICT,
  application_state_conflict: HttpStatus.CONFLICT,
  automation_incomplete_not_requeueable: HttpStatus.CONFLICT,
  posting_declined: HttpStatus.CONFLICT,
  gate_passed: HttpStatus.CONFLICT,
  alert_feeds_not_verified: HttpStatus.CONFLICT,
  too_many_requests: HttpStatus.TOO_MANY_REQUESTS,
  origin_forbidden: HttpStatus.FORBIDDEN,
  access_request_invalid: HttpStatus.BAD_REQUEST,
  rate_limited_ip: HttpStatus.TOO_MANY_REQUESTS,
  rate_limited_global: HttpStatus.TOO_MANY_REQUESTS,
  // v1.18.0 (EPIC-0006 AC-3.9)
  posting_hidden: HttpStatus.CONFLICT,
  // v1.21.0 (EPIC-0002 A2): a route behind ConvertedFeatureGuard before its converting slice
  feature_not_yet_available: HttpStatus.CONFLICT,
  advanced_locked: HttpStatus.CONFLICT,
  // v1.24.0: apply anyway, bounds and consent
  override_not_allowed: HttpStatus.CONFLICT,
  override_acknowledgement_missing: HttpStatus.CONFLICT,
  override_decision_changed: HttpStatus.CONFLICT,
  override_application_state: HttpStatus.CONFLICT,
  sample_not_allowed: HttpStatus.CONFLICT,
  // v1.25.0: EPIC-0002 B1 Job Preferences
  preferences_stale: HttpStatus.CONFLICT,
  timezone_change_rate_limited: HttpStatus.CONFLICT,
  // v1.27.0: EPIC-0010 pasted job descriptions
  job_description_too_short: HttpStatus.UNPROCESSABLE_ENTITY,
  job_description_too_long: HttpStatus.UNPROCESSABLE_ENTITY,
  job_title_required: HttpStatus.UNPROCESSABLE_ENTITY,
  job_title_too_long: HttpStatus.UNPROCESSABLE_ENTITY,
  company_required: HttpStatus.UNPROCESSABLE_ENTITY,
  company_too_long: HttpStatus.UNPROCESSABLE_ENTITY,
  employer_page_unreadable: HttpStatus.UNPROCESSABLE_ENTITY,
  posting_still_checking: HttpStatus.CONFLICT,
  manual_application_only: HttpStatus.CONFLICT,
  // v1.31.0: EPIC-0014 outreach
  outreach_reader_name_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
}

/** Message text for each error code. These strings are part of the API contract. */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  unauthenticated: "Sign in to continue.",
  session_expired:
    "Your session ended. Sign in with Google again to continue where you left off.",
  csrf_invalid: "The request is missing a valid CSRF token.",
  not_found: "Not found.",
  service_unavailable: "The service is unavailable. Try again shortly.",
  internal_error: "Something went wrong.",
  bad_request: "The request is not valid.",
  unsupported_media_type: "The request body type is not supported.",
  payload_too_large: "The request body is too large.",
  ai_provider_not_approved: "Approve Anthropic before uploading your resume.",
  resume_file_invalid: "Upload a PDF or DOCX resume up to 5 MB.",
  resume_unreadable: "Couldn't draft a Career Profile from this file.",
  resume_drafting_in_progress: "A Career Profile is already being drafted from your resume.",
  resume_storage_unavailable: "Couldn't save your resume on the server. Nothing was sent to Anthropic. Try again later.",
  career_profile_draft_exists: "A draft version already exists. Approve or discard it first.",
  ai_provider_not_configured: "The Anthropic API key isn't configured on the server.",
  career_profile_fact_empty: "Enter the fact or remove it.",
  approved_answer_value_empty: "Enter an answer.",
  approved_answer_question_empty: "Enter the question as the form asks it.",
  approved_answer_exists: "An Approved Answer for this question already exists. Edit it instead.",
  job_link_empty: "Paste a job link.",
  job_link_invalid: "Enter a full link that starts with https:// or http://.",
  job_source_not_verified: "Verify this Job Source for permitted use before enabling it.",
  job_source_unavailable: "This Job Source can't be enabled until the Candidate has the board's written permission.",
  application_not_eligible: "This Job Posting is still being checked or couldn't be checked, so it can't become an Application yet.",
  contact_details_missing: "Add your name to your contact details before generating documents.",
  document_not_available: "This document isn't available.",
  reason_empty: "Enter a reason.",
  existing_application_company_empty: "Enter the company.",
  existing_application_role_empty: "Enter the role.",
  existing_application_url_empty: "Enter the employer application URL.",
  existing_application_date_empty: "Enter the date you applied.",
  gate_requirements_unmet: "Automatic submission can't be turned on yet.",
  not_a_sample: "This Application isn't an Activation Gate sample awaiting review.",
  application_state_conflict: "This Application can't do that in its current state.",
  automation_incomplete_not_requeueable: "This Application can't go back to automatic submission. The assistant couldn't complete this form, so it won't try again. Apply yourself with the prepared documents, then mark it completed manually.",
  posting_declined: "You declined this posting, so it can't be approved.",
  gate_passed: "The Activation Gate has already passed, so no more samples are needed.",
  alert_feeds_not_verified: "Record the permitted-use verification for Google Alerts feeds before registering a feed.",
  too_many_requests: "Too many requests. Wait a minute, then try again.",
  origin_forbidden: "This request must come from the Eve page.",
  access_request_invalid: "Check the highlighted fields.",
  rate_limited_ip: "Too many requests from this network. Try again later.",
  rate_limited_global: "Eve can't take more requests today. Try again tomorrow.",
  // v1.18.0: copy-deck.r1 row api.error.posting_hidden, byte for byte (straight apostrophe).
  posting_hidden: "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why.",
  // v1.21.0 (EPIC-0002 A2): a route behind ConvertedFeatureGuard before its converting slice
  feature_not_yet_available: "This feature isn't available for your account yet.",
  // v1.24.0: copy deck C-AA-10, C-AA-12, C-AA-9, C-AA-11, C-AA-37, byte for byte from @eve/contracts.
  ...APPLY_ANYWAY_ERROR_MESSAGES,
  // v1.25.0: EPIC-0002 B1 Job Preferences
  preferences_stale: "Your preferences changed in another tab. Reload to see the latest.",
  timezone_change_rate_limited: "You can change your time zone once a day.",
  // v1.27.0: EPIC-0010 copy deck C-PD-21 to C-PD-28, byte for byte from @eve/contracts.
  ...PASTE_DESCRIPTION_ERROR_MESSAGES,
  // v1.28.0: EPIC-0011 advanced_locked, byte for byte from @eve/contracts.
  ...ADVANCED_ERROR_MESSAGES,
  // v1.31.0: EPIC-0014 copy deck C-OM-37, byte for byte from @eve/contracts.
  ...OUTREACH_ERROR_MESSAGES,
}

/** An HTTP error carrying a contract error code. The filter renders it. */
export class ApiException extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    /** Only on `resume_unreadable` (contract v1.3.0). */
    readonly reason?: ResumeRefusalReason,
    /** Only on `access_request_invalid` (contract v1.16.0). Codes, never values. */
    readonly fields?: readonly AccessRequestFieldCode[],
    /**
     * Only on the 429 codes `too_many_requests` (contract v1.15.0) and
     * `rate_limited_ip` / `rate_limited_global` (v1.16.0), and on
     * `service_unavailable` (v1.15.2, a registration lock timeout). Sent as the
     * Retry-After header, never in the body.
     */
    readonly retryAfterSeconds?: number,
    /** Only on `bad_request` from the Job criteria PUT (contract v1.13.0) or a Stack posts route (v1.14.0). */
    readonly fieldErrors?: readonly ApiFieldError[],
    /** Only on `feature_not_yet_available` (contract v1.21.0, EPIC-0002 A2). */
    readonly feature?: ConvertedFeature,
    /** Only on `preferences_stale` (contract v1.25.0, EPIC-0002 B1): null when the Candidate has no record. */
    readonly currentVersion?: number | null,
    /** Only on `timezone_change_rate_limited` (contract v1.25.0, D41). */
    readonly timeZoneLockedUntil?: Date
  ) {
    super(API_ERROR_MESSAGES[code], STATUS_BY_CODE[code])
  }

  static accessRequestInvalid(fields: readonly AccessRequestFieldCode[]): ApiException {
    return new ApiException("access_request_invalid", undefined, fields)
  }

  static rateLimited(code: "rate_limited_ip" | "rate_limited_global", retryAfterSeconds: number): ApiException {
    return new ApiException(code, undefined, undefined, retryAfterSeconds)
  }

  /** EPIC-0002 A2: a guarded route before its feature's converting slice. */
  static featureNotYetAvailable(feature: ConvertedFeature): ApiException {
    return new ApiException("feature_not_yet_available", undefined, undefined, undefined, undefined, feature)
  }

  /** v1.25.0: the save's `baseVersion` is not the current version. Nothing was written. */
  static preferencesStale(currentVersion: number | null): ApiException {
    return new ApiException("preferences_stale", undefined, undefined, undefined, undefined, undefined, currentVersion)
  }

  /** v1.25.0 (D41): a time zone change less than 24 hours after the last one. Nothing was written. */
  static timeZoneChangeRateLimited(lockedUntil: Date): ApiException {
    return new ApiException("timezone_change_rate_limited", undefined, undefined, undefined, undefined, undefined, undefined, lockedUntil)
  }

  static tooManyRequests(retryAfterSeconds: number): ApiException {
    return new ApiException("too_many_requests", undefined, undefined, retryAfterSeconds)
  }

  /** Contract v1.15.2: a database lock wait timed out; nothing was stored and the same request may be retried. */
  static serviceUnavailable(retryAfterSeconds: number): ApiException {
    return new ApiException("service_unavailable", undefined, undefined, retryAfterSeconds)
  }

  static resumeUnreadable(reason: ResumeRefusalReason): ApiException {
    return new ApiException("resume_unreadable", reason)
  }

  /**
   * v1.27.0 (EPIC-0010): a paste refusal. The code is the first entry's (order description, title,
   * company); every entry is sent. `employer_page_unreadable` carries the missing names as `required`.
   */
  static pasteFields(fieldErrors: readonly PasteFieldError[], code?: "employer_page_unreadable"): ApiException {
    const first = fieldErrors[0]
    if (first === undefined) throw new Error("pasteFields needs at least one field error")
    return new ApiException(code ?? pasteFieldErrorCode(first), undefined, undefined, undefined, fieldErrors)
  }

  static badRequestWithFieldErrors(fieldErrors: readonly ApiFieldError[]): ApiException {
    return new ApiException("bad_request", undefined, undefined, undefined, fieldErrors.length > 0 ? fieldErrors : undefined)
  }
}
