import { queryOptions } from "@tanstack/react-query"

import { fetchFormAnswers, fetchSamples, fetchSubmission, fetchSubmissionList, fetchSubmissionStatus, fetchSubmissionSummary } from "../api/submission-repository"
import { isSampleSubmitting, type SampleState, type SubmissionListView } from "./submission"

export const submissionQueryKey = ["submission"] as const
/** Prefix of every Submission list query (`submissionListQueryOptions`). CR-03: match lists by this, not by key shape. */
export const submissionListQueryKey = [...submissionQueryKey, "list"] as const

/** While a submission runs, poll its state (design-spec Real-time updates; F2 contract gap: poll until final). */
export const SUBMITTING_POLL_MS = 5_000
/** Polls per cached query before it stops asking (5 min at 5 s); reloading the page starts again. */
export const SUBMITTING_MAX_POLLS = 60

const pollWhile = (submitting: boolean, updates: number) => (submitting && updates < SUBMITTING_MAX_POLLS ? SUBMITTING_POLL_MS : false)

export function submissionStatusQueryOptions() {
  return queryOptions({ queryKey: [...submissionQueryKey, "status"], queryFn: fetchSubmissionStatus })
}

export function submissionQueryOptions(id: string) {
  return queryOptions({
    queryKey: [...submissionQueryKey, "one", id],
    queryFn: () => fetchSubmission(id),
    // Also an approved sample the worker hasn't picked up yet (v1.8.0 `pending`).
    refetchInterval: (query) => pollWhile(query.state.data !== undefined && isSampleSubmitting(query.state.data), query.state.dataUpdateCount),
  })
}

export function submissionListQueryOptions(view: SubmissionListView) {
  return queryOptions({ queryKey: [...submissionListQueryKey, view], queryFn: () => fetchSubmissionList(view) })
}

/** One Activation Gate tab (`GET /v1/samples?state=…`). */
export function samplesQueryOptions(state: SampleState) {
  return queryOptions({
    queryKey: [...submissionQueryKey, "samples", state],
    queryFn: () => fetchSamples(state),
    // The Approved tab follows samples the worker is still submitting (v1.8.0).
    refetchInterval: (query) => pollWhile(query.state.data?.some((row) => isSampleSubmitting(row.submission)) === true, query.state.dataUpdateCount),
  })
}

/** Counts for Home's Needs you list and the sidebar badges. */
export function submissionSummaryQueryOptions() {
  return queryOptions({ queryKey: [...submissionQueryKey, "summary"], queryFn: fetchSubmissionSummary })
}

/** The answers a sample's form will receive (C-SAMPLE-14 to 17). Under the submission key, so adding an Approved Answer refetches it with the rest. */
export function formAnswersQueryOptions(id: string) {
  return queryOptions({ queryKey: [...submissionQueryKey, "form-answers", id], queryFn: () => fetchFormAnswers(id) })
}
