import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import { APPLY_ANYWAY_ERROR_MESSAGES, type ApiErrorCode } from "@eve/contracts"

import { applicationCopy, applicationsQueryKey, type ApplicationDetailFocusState, createApplication, overrideCopy, submissionStatusQueryOptions } from "@/entities/application"
import { jobPostingsQueryKey, relevanceCopy, skipLine, type JobPostingDetail, type OverrideDecision } from "@/entities/job-posting"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"
import { actionFailedMessage } from "@/shared/lib/action-failed"
import { toast } from "@/shared/ui/toast"

/**
 * The refusal panel text per 409 code on "Prepare documents anyway" (design B1,
 * feedback matrix; AA-7.2). Each equals the contract message byte for byte.
 */
const REFUSALS: Partial<Record<ApiErrorCode, string>> = {
  override_decision_changed: APPLY_ANYWAY_ERROR_MESSAGES.override_decision_changed,
  override_not_allowed: APPLY_ANYWAY_ERROR_MESSAGES.override_not_allowed,
  override_application_state: APPLY_ANYWAY_ERROR_MESSAGES.override_application_state,
  override_acknowledgement_missing: APPLY_ANYWAY_ERROR_MESSAGES.override_acknowledgement_missing,
  posting_hidden: relevanceCopy.api.error.posting_hidden,
  application_not_eligible: applicationCopy.notEligible,
}

/** What the dialog shows, fixed when it opens (design B2 "Snapshot rule"). */
export interface OverrideSnapshot {
  readonly decision: OverrideDecision
  /** The posting's own reason line for that decision (C-JC-SKIP-WEAK / C-SKIP-4, C-SKIP-2, C-SKIP-4a, C-SKIP-1). */
  readonly reasonLine: string
}

function snapshotOf(posting: JobPostingDetail, decision: OverrideDecision): OverrideSnapshot {
  const line = skipLine({ skipReason: decision.skipReason, skipDetail: decision.skipDetail, applicationSystem: posting.applicationSystem, coverage: posting.coverage })
  return { decision, reasonLine: line ?? "" }
}

/**
 * F1: "Prepare documents anyway". Opens the consent dialog with a snapshot of
 * the server's decision, sends it as the acknowledgement, and handles every
 * outcome: navigate (with C-AA-14 when the posting became ranked), a 409 panel
 * with a refetched posting, or an inline network error that keeps the dialog open.
 */
export function usePrepareAnyway(posting: JobPostingDetail) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const cap = useQuery(submissionStatusQueryOptions()).data?.cap ?? null
  const [snapshot, setSnapshot] = useState<OverrideSnapshot | null>(null)
  const [inlineError, setInlineError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  /** After a refusal the button may be gone, so focus goes to the page heading (design Accessibility). */
  const focusHeading = useRef(false)

  const mutation = useMutation({
    mutationFn: async (decision: OverrideDecision) => createApplication(posting.id, await ensureCsrfToken(queryClient), decision),
    onSuccess: ({ application }) => {
      void queryClient.invalidateQueries({ queryKey: applicationsQueryKey })
      void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey })
      setSnapshot(null)
      // The detail focuses its title once the record renders (design B3 Accessibility).
      void navigate(`/applications/${application.id}`, { state: { focusTitle: true } satisfies ApplicationDetailFocusState })
      // The posting became ranked after the dialog opened: no override was recorded (C-AA-14).
      if (application.override === null) toast.info(overrideCopy.becameRanked)
    },
    onError: (error) => {
      const message = error instanceof ApiError && error.code ? REFUSALS[error.code] : undefined
      if (message) {
        focusHeading.current = true
        setSnapshot(null)
        setRefusal(message)
        void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey })
        return
      }
      setInlineError(actionFailedMessage(overrideCopy.actionPhrase))
    },
  })

  const open = () => {
    if (!posting.applyAnyway) return
    focusHeading.current = false
    setRefusal(null)
    setInlineError(null)
    setSnapshot(snapshotOf(posting, posting.applyAnyway.decision))
  }

  return {
    cap,
    snapshot,
    refusal,
    inlineError,
    isPending: mutation.isPending,
    open,
    close: () => {
      if (!mutation.isPending) setSnapshot(null)
    },
    confirm: () => {
      if (snapshot && !mutation.isPending) {
        setInlineError(null)
        mutation.mutate(snapshot.decision)
      }
    },
    /** For the dialog's `finalFocus`: the heading after a refusal, else the opening button. */
    shouldFocusHeading: () => focusHeading.current,
  }
}
