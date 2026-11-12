import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { APPLY_ANYWAY_ERROR_MESSAGES } from "@eve/contracts"

import { applicationsQueryKey, createApplication } from "@/entities/application"
import { jobPostingsQueryKey, skipLine, type JobPostingDetail } from "@/entities/job-posting"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"

/**
 * "Prepare resume and cover letter" on Home, without leaving the page (R1). The request is the existing
 * `POST /v1/applications`; for a Not a match job the same Override acknowledgement the posting page sends.
 * `anywayReason` is the plain reason line the confirm dialog quotes.
 */
export function usePrepareInPlace(posting: JobPostingDetail) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const decision = posting.applyAnyway?.decision ?? null
  const mutation = useMutation({
    mutationFn: async (override: boolean) =>
      createApplication(posting.id, await ensureCsrfToken(queryClient), override && decision ? decision : null),
    onMutate: () => setFailed(null),
    onSuccess: ({ application }) => {
      setApplicationId(application.id)
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: applicationsQueryKey })
      void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey })
    },
    onError: (error) => {
      setConfirming(false)
      setFailed(error instanceof ApiError && error.code === "override_decision_changed" ? APPLY_ANYWAY_ERROR_MESSAGES.override_decision_changed : "")
    },
  })
  const anywayReason = decision
    ? (skipLine({ skipReason: decision.skipReason, skipDetail: decision.skipDetail, applicationSystem: posting.applicationSystem, coverage: posting.coverage }) ?? "")
    : ""
  return {
    applicationId: applicationId ?? posting.applicationId,
    isPending: mutation.isPending,
    failed,
    anywayReason,
    confirming,
    setConfirming,
    prepare: () => mutation.mutate(false),
    askAnyway: () => setConfirming(true),
    confirmAnyway: () => mutation.mutate(true),
  }
}
