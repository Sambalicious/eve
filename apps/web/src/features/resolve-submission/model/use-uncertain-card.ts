import { useState } from "react"

import { submissionCopy, type SubmissionRow, type SubmissionStatus } from "@/entities/application"
import { toastError, toastSuccess } from "@/shared/lib/action-failed"
import { useSubmissionAction } from "./use-submission-action"

const u = submissionCopy.uncertain
const s = submissionCopy.status

type Dialog = "confirmed" | "not_submitted" | null

/**
 * The two actions of an Uncertain Submission card (F6 steps 4 and 4a, F2 for
 * samples). The dialog and toast depend on whether this is a sample, and on
 * whether it is already the one more attempt. A result the backend already
 * had (another tab, a confirmation first) shows C-UNC-4.
 */
export function useUncertainCard(row: SubmissionRow, status: SubmissionStatus | undefined) {
  const { application, submission } = row
  const [dialog, setDialog] = useState<Dialog>(null)
  const isSample = submission.kind === "sample"
  const isFresh = !isSample && submission.attemptNumber >= 2
  const gatePassed = status?.gatePassedAt != null
  const company = application.company ?? application.requisitionId
  const close = () => setDialog(null)

  const confirm = useSubmissionAction({
    failure: "mark this confirmed",
    onDone: () => {
      close()
      toastSuccess(u.confirmedToast(submission.submittedWatDay ?? status?.todayWatDay ?? ""))
    },
    onRefused: () => resolvedElsewhere(close),
  })
  const notSubmitted = useSubmissionAction({
    failure: "mark this not submitted",
    onDone: (after) => {
      close()
      if (after.state === "confirmed") return toastError(u.alreadyResolved(s.confirmed))
      if (isSample) return toastSuccess(submissionCopy.sample.markedNotSubmittedToast(gatePassed, Math.max(0, (status?.countingSamples ?? 1) - 1)))
      if (after.state === "queued") return toastSuccess(u.notSubmittedToast)
      return toastSuccess(u.notSubmittedFinalToast)
    },
    onRefused: () => resolvedElsewhere(close),
  })

  const missingAfterMark = Math.max(1, (status?.requiredSamples ?? 5) - (status?.countingSamples ?? 0) + 1)
  const notSubmittedDialog = isSample
    ? {
        title: u.confirmNotSubmitted.sampleTitle,
        body: gatePassed ? u.confirmNotSubmitted.sampleAfter(company) : u.confirmNotSubmitted.sampleBefore(company, missingAfterMark),
      }
    : { title: u.confirmNotSubmitted.title, body: isFresh ? u.confirmNotSubmitted.fresh : u.confirmNotSubmitted.first }

  return {
    dialog,
    setDialog,
    isSample,
    isFresh,
    notSubmittedDialog,
    confirm: { run: () => confirm.run({ action: "mark_confirmed", id: application.id }), isPending: confirm.isPending },
    notSubmitted: { run: () => notSubmitted.run({ action: "mark_not_submitted", id: application.id }), isPending: notSubmitted.isPending },
  }
}

/** `application_state_conflict`: resolved in another tab. The 409 doesn't carry the status, so C-UNC-4a; the list refetches. */
function resolvedElsewhere(close: () => void): boolean {
  close()
  toastError(u.alreadyResolvedUnknown)
  return true
}
