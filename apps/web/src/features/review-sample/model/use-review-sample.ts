import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  applicationsQueryKey,
  isSampleSubmitting,
  approveSample,
  submissionCopy,
  submissionQueryKey,
  submitReasonAction,
  type SampleResult,
  type Submission,
} from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError, hasErrorCode } from "@/shared/api"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"
import { useSampleSettle } from "./use-sample-settle"

type Dialog = "approve" | "reject" | null

/**
 * Approve (C-CONFIRM-3, submits now) or reject with a reason (C-SAMPLE-7).
 * After an approval the action bar gives way to the result; a second approval
 * returns the first result (`alreadyDone`, C-SAMPLE-6).
 *
 * An approval answers `pending` while the worker submits (v1.8.0). Until the
 * worker finishes, `submitting` is true and the page polls the Submission; the
 * outcome then replaces `pending`. A sample found approved and unfinished on
 * load (reload, second tab) is followed the same way.
 */
export function useReviewSample(applicationId: string, submission: Submission | undefined) {
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [result, setResult] = useState<SampleResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [rejectError, setRejectError] = useState<string | null>(null)
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: submissionQueryKey }), queryClient.invalidateQueries({ queryKey: applicationsQueryKey })])

  // Latched: the settle read updates the cached Submission, which must not stop the following before the outcome is shown.
  const [followOnLoad, setFollowOnLoad] = useState(false)
  if (!followOnLoad && result === null && submission !== undefined && isSampleSubmitting(submission)) setFollowOnLoad(true)
  const submitting = result?.result === "pending" || (result === null && followOnLoad)
  const settle = useSampleSettle(applicationId, submitting, (next) => {
    setResult(next)
    setAttempt((n) => n + 1)
    void refresh()
  })

  const approve = useMutation({
    mutationFn: async () => approveSample(applicationId, await ensureCsrfToken(queryClient)),
    onSuccess: async (next) => {
      setDialog(null)
      setResult(next)
      setAttempt((n) => n + 1)
      await refresh()
    },
    onError: async (error) => {
      setDialog(null)
      await refresh()
      if (hasErrorCode(error, "not_a_sample")) return
      toastActionFailed("approve and submit this sample")
    },
  })
  const reject = useMutation({
    mutationFn: async (reason: string) => submitReasonAction("reject_sample", applicationId, reason, await ensureCsrfToken(queryClient)),
    onSuccess: async () => {
      setDialog(null)
      toastSuccess(submissionCopy.sample.rejectedToast)
      await refresh()
    },
    onError: async (error) => {
      if (hasErrorCode(error, "reason_empty")) return setRejectError(submissionCopy.validation.sampleReasonEmpty)
      setDialog(null)
      await refresh()
      if (error instanceof ApiError && error.code === "not_a_sample") return
      toastActionFailed("reject this sample")
    },
  })

  return {
    dialog,
    setDialog: (next: Dialog) => {
      setRejectError(null)
      setDialog(next)
    },
    result,
    /** Changes with each approval answer, so a repeated result is announced again. */
    attempt,
    rejectError,
    /** The worker hasn't finished this sample yet. */
    submitting,
    /** Still submitting after the polling gave up. */
    stalled: settle.stalled,
    approve: { run: () => approve.mutate(), isPending: approve.isPending || submitting },
    reject: { run: (reason: string) => reject.mutate(reason), isPending: reject.isPending },
  }
}
