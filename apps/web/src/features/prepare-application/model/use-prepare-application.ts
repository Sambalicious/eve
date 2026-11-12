import { useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"

import { applicationCopy, applicationsQueryKey, createApplication } from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { toastActionFailed, toastError } from "@/shared/lib/action-failed"

/**
 * Creates the Application for a ranked posting (or finds the existing one:
 * one per requisition) and opens its detail page, where documents are generated.
 */
export function usePrepareApplication() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const mutation = useMutation({
    mutationFn: async (jobPostingId: string) => createApplication(jobPostingId, await ensureCsrfToken(queryClient)),
    onSuccess: ({ application }) => {
      void queryClient.invalidateQueries({ queryKey: applicationsQueryKey })
      void navigate(`/applications/${application.id}`)
    },
    onError: (error) => {
      if (hasErrorCode(error, "application_not_eligible")) return toastError(applicationCopy.notEligible)
      toastActionFailed("prepare the Application")
    },
  })
  // A double click fires before the pending state renders; one create per press (DOC:202, PD-4.5).
  const inFlight = useRef(false)
  const prepare = (jobPostingId: string) => {
    if (inFlight.current) return
    inFlight.current = true
    mutation.mutate(jobPostingId, { onSettled: () => (inFlight.current = false) })
  }
  return { prepare, isPreparing: mutation.isPending }
}
