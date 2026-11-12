import {
  AUTOMATIC_SUBMISSION_PATH,
  formAnswersPath,
  formAnswersResponseSchema,
  prepareSamplesResultSchema,
  SAMPLES_PREPARE_PATH,
  samplesPath,
  samplesResponseSchema,
  SUBMISSIONS_SUMMARY_PATH,
  submissionSummarySchema,
  manualCompletePath,
  queueApplicationPath,
  removeFromQueuePath,
  markConfirmedPath,
  markNotSubmittedPath,
  sameCompanyApprovePath,
  sameCompanyDeclinePath,
  sampleApprovePath,
  sampleRejectPath,
  sampleResultSchema,
  SUBMISSION_STATUS_PATH,
  submissionListResponseSchema,
  submissionSchema,
  submissionsPath,
  submissionStatusSchema,
  type Submission as SubmissionBody,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type {
  FormAnswers,
  PrepareSamplesResult,
  SampleResult,
  SampleRow,
  SampleState,
  Submission,
  SubmissionListView,
  SubmissionRow,
  SubmissionStatus,
  SubmissionSummary,
} from "../model/submission"
import { toApplication } from "./application-repository"

const submissionPath = (id: string) => `/v1/applications/${encodeURIComponent(id)}/submission`
const enc = encodeURIComponent

export async function fetchSubmissionStatus(): Promise<SubmissionStatus> {
  const response = await apiRequest(SUBMISSION_STATUS_PATH)
  return toStatus(submissionStatusSchema.parse(await response.json()))
}

export async function setAutomaticSubmission(enabled: boolean, csrfToken: string): Promise<SubmissionStatus> {
  const response = await apiRequest(AUTOMATIC_SUBMISSION_PATH, { method: "PUT", csrfToken, json: { enabled } })
  return toStatus(submissionStatusSchema.parse(await response.json()))
}

export async function fetchSubmission(id: string): Promise<Submission> {
  const response = await apiRequest(submissionPath(id))
  return toSubmission(submissionSchema.parse(await response.json()))
}

export async function fetchSubmissionList(view: SubmissionListView): Promise<SubmissionRow[]> {
  const response = await apiRequest(submissionsPath(view))
  return submissionListResponseSchema
    .parse(await response.json())
    .rows.map((row) => ({ application: toApplication(row.application), submission: toSubmission(row.submission) }))
}

export async function fetchSamples(state: SampleState): Promise<SampleRow[]> {
  const response = await apiRequest(samplesPath(state))
  return samplesResponseSchema.parse(await response.json()).rows.map((row) => ({
    application: toApplication(row.application),
    submission: toSubmission(row.submission),
    applicationSystem: row.applicationSystem,
    match: row.match ? { covered: row.match.coveredCount, total: row.match.totalCount } : null,
    unverifiedLabels: row.unverifiedLabels,
  }))
}

export async function fetchSubmissionSummary(): Promise<SubmissionSummary> {
  const response = await apiRequest(SUBMISSIONS_SUMMARY_PATH)
  return submissionSummarySchema.parse(await response.json())
}

export async function prepareSamples(csrfToken: string): Promise<PrepareSamplesResult> {
  const response = await apiRequest(SAMPLES_PREPARE_PATH, { method: "POST", csrfToken })
  return prepareSamplesResultSchema.parse(await response.json())
}

export async function fetchFormAnswers(id: string): Promise<FormAnswers> {
  const response = await apiRequest(formAnswersPath(enc(id)))
  const body = formAnswersResponseSchema.parse(await response.json())
  return {
    available: body.available,
    answers: body.answers.map((a) => ({
      question: a.question,
      source: a.source,
      value: a.value,
      redacted: a.redacted,
      blockedReason: a.blockedReason,
      manualOnly: a.manualOnly === true,
    })),
  }
}

export async function approveSample(id: string, csrfToken: string): Promise<SampleResult> {
  const response = await apiRequest(sampleApprovePath(enc(id)), { method: "POST", csrfToken })
  const body = sampleResultSchema.parse(await response.json())
  return { result: body.result, alreadyDone: body.alreadyDone, countingSamples: body.countingSamples, gatePassedAt: body.gatePassedAt }
}

type ReasonAction = "reject_sample" | "decline_same_company"
type PlainAction = "mark_confirmed" | "mark_not_submitted" | "manual_complete" | "approve_same_company" | "queue" | "remove_from_queue"

const PLAIN_PATHS: Record<PlainAction, (id: string) => string> = {
  mark_confirmed: markConfirmedPath,
  mark_not_submitted: markNotSubmittedPath,
  manual_complete: manualCompletePath,
  approve_same_company: sameCompanyApprovePath,
  queue: queueApplicationPath,
  remove_from_queue: removeFromQueuePath,
}
const REASON_PATHS: Record<ReasonAction, (id: string) => string> = {
  reject_sample: sampleRejectPath,
  decline_same_company: sameCompanyDeclinePath,
}

/** One of the Candidate's submission actions; returns the Submission as it is afterwards. */
export async function submitAction(action: PlainAction, id: string, csrfToken: string): Promise<Submission> {
  const response = await apiRequest(PLAIN_PATHS[action](enc(id)), { method: "POST", csrfToken })
  return toSubmission(submissionSchema.parse(await response.json()))
}

/** Sample reject or same-company decline, both with a required reason. */
export async function submitReasonAction(action: ReasonAction, id: string, reason: string, csrfToken: string): Promise<Submission> {
  const response = await apiRequest(REASON_PATHS[action](enc(id)), { method: "POST", csrfToken, json: { reason } })
  return toSubmission(submissionSchema.parse(await response.json()))
}

export type { PlainAction as SubmissionAction, ReasonAction as SubmissionReasonAction }

function toStatus(body: ReturnType<typeof submissionStatusSchema.parse>): SubmissionStatus {
  return { ...body }
}

export function toSubmission(body: SubmissionBody): Submission {
  return {
    state: body.state,
    kind: body.kind,
    attemptNumber: body.attemptNumber,
    submittedAt: body.submittedAt,
    submittedWatDay: body.submittedWatDay,
    evidence: body.evidence,
    captchaAfterSubmit: body.captchaAfterSubmit,
    blocked: body.blockedReason
      ? { reason: body.blockedReason, subReason: body.blockedSubReason, detail: body.blockedDetail, question: body.blockedQuestion, at: body.blockedAt }
      : null,
    queuedForWatDay: body.queuedForWatDay,
    sample: body.sample,
    declinedReason: body.declinedReason,
    declinedAt: body.declinedAt,
    markedNotSubmittedAt: body.markedNotSubmittedAt,
    manualCompletedAt: body.manualCompletedAt,
    override: body.override && { ...body.override, violatedRules: body.override.violatedRules && [...body.override.violatedRules] },
  }
}
