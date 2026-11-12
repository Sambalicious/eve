import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { applicationsQueryKey, overrideCopy, submissionQueryKey, submitAction } from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { actionFailedMessage, toastError, toastSuccess } from "@/shared/lib/action-failed"

/**
 * F3: Remove from queue. Success (also the idempotent repeat) closes the dialog,
 * refetches and shows C-AA-29 once. `409 application_state_conflict` closes it,
 * refetches and shows C-AA-30. A network or server failure stays in the dialog
 * with C-ERR-2 and C-AA-31. Works during either pause (AA-5.4): no pause check.
 */
export function useRemoveFromQueue(applicationId: string) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [inlineError, setInlineError] = useState<string | null>(null)
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: submissionQueryKey }), queryClient.invalidateQueries({ queryKey: applicationsQueryKey })])

  const mutation = useMutation({
    mutationFn: async () => submitAction("remove_from_queue", applicationId, await ensureCsrfToken(queryClient)),
    onSuccess: async () => {
      setOpen(false)
      toastSuccess(overrideCopy.queue.success)
      await refresh()
    },
    onError: (error) => {
      if (hasErrorCode(error, "application_state_conflict")) {
        setOpen(false)
        toastError(overrideCopy.queue.conflict)
        void refresh()
        return
      }
      setInlineError(actionFailedMessage(overrideCopy.queue.actionPhrase))
    },
  })

  return {
    open,
    inlineError,
    isPending: mutation.isPending,
    openDialog: () => {
      setInlineError(null)
      setOpen(true)
    },
    close: () => {
      if (!mutation.isPending) setOpen(false)
    },
    confirm: () => {
      if (mutation.isPending) return
      setInlineError(null)
      mutation.mutate()
    },
  }
}
