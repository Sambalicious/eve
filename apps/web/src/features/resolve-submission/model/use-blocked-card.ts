import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { applicationName, submissionCopy, submissionQueryOptions, type SubmissionRow } from "@/entities/application"
import { toastError, toastSuccess } from "@/shared/lib/action-failed"
import { useSubmissionAction } from "./use-submission-action"

type Dialog = "manual" | "approve" | "decline" | null

/**
 * The actions of one Blocked Application card: mark completed manually,
 * approve or decline a same-company review, and return to the queue after an
 * Approved Answer was added. Refusals the contract names are shown inline
 * (C-BLOCK-14, C-BLOCK-12d) or as the design's toasts (C-BLOCK-12a/b).
 */
export function useBlockedCard(row: SubmissionRow) {
  const { application, submission } = row
  const [dialog, setDialog] = useState<Dialog>(null)
  const [inline, setInline] = useState<string | null>(null)
  const [answerSaved, setAnswerSaved] = useState(false)
  const role = application.roleTitle ?? applicationName(application)
  const company = application.company ?? applicationName(application)
  const close = () => setDialog(null)
  const sentReason = useRef("")
  const queryClient = useQueryClient()

  const manual = useSubmissionAction({
    failure: "mark this completed manually",
    onDone: () => {
      close()
      toastSuccess(submissionCopy.blocked.manualToast)
    },
  })
  const approve = useSubmissionAction({
    failure: "approve this submission",
    onDone: close,
    onRefused: (error) => {
      close()
      if (error.code !== "posting_declined") return false
      // Declined in another tab: this row predates it, so read the decline date from the current Submission (C-BLOCK-12d).
      // The card stays with the refusal: refetching the list now would remove it, the posting being no longer held.
      setInline(submissionCopy.blocked.approveRefusedDeclined(submission.declinedAt))
      void queryClient
        .fetchQuery({ ...submissionQueryOptions(application.id), staleTime: 0 })
        .then((current) => current.declinedAt && setInline(submissionCopy.blocked.approveRefusedDeclined(current.declinedAt)))
        .catch(() => undefined)
      return "inline"
    },
  })
  const decline = useSubmissionAction({
    failure: "decline this posting",
    onDone: (after) => {
      close()
      // A second decline keeps the first reason (contract), so a different stored reason means C-BLOCK-12a.
      if (after.state !== "declined") toastError(submissionCopy.blocked.alreadyApproved)
      else if (after.declinedReason !== null && after.declinedReason !== sentReason.current) toastError(submissionCopy.blocked.alreadyDeclined(after.declinedAt))
      else toastSuccess(submissionCopy.blocked.declinedToast(role, company))
    },
    onRefused: (error) => {
      if (error.code === "reason_empty") return false
      close()
      toastError(submissionCopy.blocked.alreadyApproved)
      return true
    },
  })
  const requeue = useSubmissionAction({
    failure: "return this Application to automatic submission",
    onDone: () => undefined,
    onRefused: (error) => {
      if (error.code !== "automation_incomplete_not_requeueable") return false
      setInline(submissionCopy.blocked.notRequeueable)
      return true
    },
  })

  return {
    dialog,
    setDialog,
    inline,
    answerSaved,
    role,
    company,
    isDeclinedAlready: submission.state === "declined",
    manual: { run: () => manual.run({ action: "manual_complete", id: application.id }), isPending: manual.isPending },
    approve: { run: () => approve.run({ action: "approve_same_company", id: application.id }), isPending: approve.isPending },
    decline: {
      run: (reason: string) => {
        sentReason.current = reason.trim()
        decline.run({ action: "decline_same_company", id: application.id, reason })
      },
      isPending: decline.isPending,
    },
    /** After the missing Approved Answer is saved: C-BLOCK-9, and the Application goes back to the queue. */
    onAnswerSaved: () => {
      setAnswerSaved(true)
      requeue.run({ action: "queue", id: application.id })
    },
  }
}
