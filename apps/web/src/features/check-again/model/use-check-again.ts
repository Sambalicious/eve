import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { checkAgain, jobPostingsQueryKey } from "@/entities/job-posting"
import { ensureCsrfToken } from "@/entities/session"
import { toast } from "@/shared/ui/toast"
import { checkAgainFailure, checkAgainToast } from "./check-again-outcome"

/**
 * The Check again dialog's state and request (design-spec.r1 B5). On 200 the
 * dialog closes, the toast shows and every postings query is invalidated. On a
 * failure the dialog stays open with its alert; the confirm button retries.
 */
export function useCheckAgain({ onAnnounce }: { onAnnounce: (text: string) => void }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  /** True after a press that moved rows: the panel is about to leave, so focus goes to the active tab (DP-2). */
  const [movedRows, setMovedRows] = useState(false)
  const mutation = useMutation({
    mutationFn: async () => checkAgain(await ensureCsrfToken(queryClient)),
    onSuccess: (result) => {
      setMovedRows(result.queued > 0)
      setOpen(false)
      setAlert(null)
      void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey })
      const outcome = checkAgainToast(result)
      if (outcome.tone === "success") toast.success(outcome.text)
      else toast.info(outcome.text)
      if (outcome.announce) onAnnounce(outcome.announce)
    },
    onError: (error) => {
      const failure = checkAgainFailure(error)
      if (failure.kind === "signed_out") {
        setOpen(false)
        return
      }
      setAlert(failure.message)
    },
  })

  return {
    open,
    alert,
    isPending: mutation.isPending,
    movedRows,
    openDialog: () => {
      setAlert(null)
      setMovedRows(false)
      setOpen(true)
    },
    onOpenChange: (next: boolean) => {
      if (mutation.isPending) return
      setOpen(next)
      if (!next) setAlert(null)
    },
    confirm: () => {
      if (!mutation.isPending) mutation.mutate()
    },
  }
}
