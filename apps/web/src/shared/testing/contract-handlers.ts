import {
  ADVANCED_ERROR_MESSAGES,
  apiErrorResponseSchema,
  APPLY_ANYWAY_ERROR_MESSAGES,
  CSRF_HEADER,
  LOGOUT_PATH,
  OUTREACH_ERROR_MESSAGES,
  PASTE_DESCRIPTION_ERROR_MESSAGES,
  SESSION_PATH,
  type ApiErrorCode,
  type ApiErrorResponse,
  type PasteFieldError,
  type ResumeRefusalReason,
  type SessionResponse,
} from "@eve/contracts"
import { http, HttpResponse } from "msw"

import { freshInstallationHandlers } from "./career-setup-api"
import { freshControlsHandlers } from "./controls-api"
import { freshDiscoveryHandlers } from "./discovery-api"
import { freshDocumentsHandlers } from "./documents-api"
import { freshMeHandlers } from "./me-api"
import { freshNotificationHandlers } from "./notifications-api"
import { freshOutreachHandlers } from "./outreach-api"
import { freshPreferencesHandlers } from "./preferences-api"
import { freshSubmissionHandlers } from "./submission-api"

/** A CSRF token shaped like the contract's: base64url, 43 characters. */
export const TEST_CSRF_TOKEN = "dGVzdC1jc3JmLXRva2VuLWZvci12aXRlc3QtcnVucy0"

/** Exact messages from api-contract.md, "Error format". */
const ERROR_MESSAGES = {
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
  ai_provider_not_configured: "The Anthropic API key isn't configured on the server.",
  resume_file_invalid: "Upload a PDF or DOCX resume up to 5 MB.",
  resume_unreadable: "Couldn't draft a Career Profile from this file.",
  resume_drafting_in_progress: "A Career Profile is already being drafted from your resume.",
  resume_storage_unavailable: "Couldn't save your resume on the server. Nothing was sent to Anthropic. Try again later.",
  career_profile_draft_exists: "A draft version already exists. Approve or discard it first.",
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
  posting_hidden:
    "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why.",
  feature_not_yet_available: "This feature isn't available for your account yet.",
  // v1.24.0: byte for byte from the contracts package (copy deck api.error.*).
  ...APPLY_ANYWAY_ERROR_MESSAGES,
  // v1.25.0: EPIC-0002 B1 Job Preferences
  preferences_stale: "Your preferences changed in another tab. Reload to see the latest.",
  timezone_change_rate_limited: "You can change your time zone once a day.",
  // v1.27.0: EPIC-0010 pasted job descriptions, byte for byte from the contracts package.
  ...PASTE_DESCRIPTION_ERROR_MESSAGES,
  // v1.28.0: EPIC-0011, byte for byte from the contracts package.
  ...ADVANCED_ERROR_MESSAGES,
  // v1.31.0: EPIC-0014 outreach, byte for byte from the contracts package.
  ...OUTREACH_ERROR_MESSAGES,
} as const satisfies Record<ApiErrorCode, string>

const ERROR_STATUS = {
  unauthenticated: 401,
  session_expired: 401,
  csrf_invalid: 403,
  not_found: 404,
  service_unavailable: 503,
  internal_error: 500,
  bad_request: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  ai_provider_not_approved: 409,
  ai_provider_not_configured: 503,
  resume_file_invalid: 422,
  resume_unreadable: 422,
  resume_drafting_in_progress: 409,
  resume_storage_unavailable: 503,
  career_profile_draft_exists: 409,
  career_profile_fact_empty: 422,
  approved_answer_value_empty: 422,
  approved_answer_question_empty: 422,
  approved_answer_exists: 409,
  job_link_empty: 422,
  job_link_invalid: 422,
  job_source_not_verified: 409,
  job_source_unavailable: 409,
  application_not_eligible: 409,
  contact_details_missing: 409,
  document_not_available: 404,
  reason_empty: 422,
  existing_application_company_empty: 422,
  existing_application_role_empty: 422,
  existing_application_url_empty: 422,
  existing_application_date_empty: 422,
  gate_requirements_unmet: 409,
  not_a_sample: 409,
  application_state_conflict: 409,
  automation_incomplete_not_requeueable: 409,
  posting_declined: 409,
  gate_passed: 409,
  alert_feeds_not_verified: 409,
  too_many_requests: 429,
  origin_forbidden: 403,
  access_request_invalid: 400,
  rate_limited_ip: 429,
  rate_limited_global: 429,
  posting_hidden: 409,
  feature_not_yet_available: 409,
  override_not_allowed: 409,
  override_acknowledgement_missing: 409,
  override_decision_changed: 409,
  override_application_state: 409,
  sample_not_allowed: 409,
  preferences_stale: 409,
  timezone_change_rate_limited: 409,
  job_description_too_short: 422,
  job_description_too_long: 422,
  job_title_required: 422,
  job_title_too_long: 422,
  company_required: 422,
  company_too_long: 422,
  employer_page_unreadable: 422,
  posting_still_checking: 409,
  manual_application_only: 409,
  advanced_locked: 409,
  outreach_reader_name_invalid: 422,
} as const satisfies Record<ApiErrorCode, number>

/** The contract error envelope. `reason` is only valid with `resume_unreadable` (v1.3.0). */
export function apiErrorResponse(code: ApiErrorCode, reason?: ResumeRefusalReason) {
  const body: ApiErrorResponse = { error: { code, message: ERROR_MESSAGES[code], ...(reason && { reason }) } }
  return HttpResponse.json(body, { status: ERROR_STATUS[code] })
}

/** v1.27.0: a paste refusal carrying `fieldErrors` (the six field codes and `employer_page_unreadable`). */
export function pasteErrorResponse(code: ApiErrorCode, fieldErrors: readonly PasteFieldError[]) {
  const body: ApiErrorResponse = { error: { code, message: ERROR_MESSAGES[code], fieldErrors: [...fieldErrors] } }
  return HttpResponse.json(apiErrorResponseSchema.parse(body), { status: ERROR_STATUS[code] })
}

/** `GET /v1/session` for a signed-in Candidate. */
export const signedInSession = http.get(SESSION_PATH, () => {
  const body: SessionResponse = { csrfToken: TEST_CSRF_TOKEN }
  return HttpResponse.json(body, { headers: { "cache-control": "no-store" } })
})

export const noSession = http.get(SESSION_PATH, () =>
  apiErrorResponse("unauthenticated")
)

export const expiredSession = http.get(SESSION_PATH, () =>
  apiErrorResponse("session_expired")
)

/** `POST /v1/auth/logout`: 204 with the right CSRF header, 403 otherwise. */
export const logoutEndpoint = http.post(LOGOUT_PATH, ({ request }) => {
  if (request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN) {
    return apiErrorResponse("csrf_invalid")
  }
  return new HttpResponse(null, { status: 204 })
})

/**
 * Default handlers: an unauthenticated browser, as on first visit. Slice 2
 * reads answer as a new installation once a test signs in.
 */
export const defaultHandlers = [noSession, logoutEndpoint, ...freshInstallationHandlers, ...freshDiscoveryHandlers, ...freshDocumentsHandlers, ...freshSubmissionHandlers, ...freshNotificationHandlers, ...freshControlsHandlers, ...freshPreferencesHandlers, ...freshMeHandlers, ...freshOutreachHandlers]
