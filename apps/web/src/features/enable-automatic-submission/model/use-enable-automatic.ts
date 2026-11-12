import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { missingGateRequirements, setAutomaticSubmission, submissionCopy, submissionQueryKey, type SubmissionStatus } from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { viewerQueryKey } from "@/entities/viewer"
import { hasErrorCode } from "@/shared/api"
import { toastActionFailed } from "@/shared/lib/action-failed"

/**
 * "Turn on automatic submission" (F2 steps 5, 6). With a requirement unmet the
 * control stays focusable (`aria-disabled`) and shows C-GATE-3; otherwise it
 * confirms with C-CONFIRM-4. A `gate_requirements_unmet` refusal also shows
 * C-GATE-3, built from fresh status.
 */
export function useEnableAutomatic(status: SubmissionStatus) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const missing = missingGateRequirements(status)
  const isReady = status.gatePassedAt !== null
  const mutation = useMutation({
    mutationFn: async () => setAutomaticSubmission(true, await ensureCsrfToken(queryClient)),
    onSuccess: (next) => {
      queryClient.setQueryData([...submissionQueryKey, "status"], next)
      setConfirming(false)
      // Contract v1.28.0 C2: the server also sets `advancedEnabled` and `advancedLocked`
      // in this transaction, so the cached viewer must be refetched (CR-01).
      void queryClient.invalidateQueries({ queryKey: viewerQueryKey })
    },
    onError: async (error) => {
      setConfirming(false)
      if (!hasErrorCode(error, "gate_requirements_unmet")) return toastActionFailed("turn on automatic submission")
      await queryClient.invalidateQueries({ queryKey: submissionQueryKey })
      const fresh = queryClient.getQueryData<SubmissionStatus>([...submissionQueryKey, "status"]) ?? status
      setRefusal(submissionCopy.gate.refused(missingGateRequirements(fresh)))
    },
  })
  return {
    confirming,
    setConfirming,
    refusal,
    isPending: mutation.isPending,
    activate: () => {
      if (isReady) return setConfirming(true)
      setRefusal(submissionCopy.gate.refused(missing.length > 0 ? missing : [{ kind: "samples", missing: 1 }]))
    },
    confirm: () => mutation.mutate(),
  }
}
