import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { editOutcome, outcomeCopy, outcomesQueryKey, recordOutcome, type Outcome, type OutcomeType } from "@/entities/outcome"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

/** What the dialog is doing: recording a new Outcome, or editing one. */
export type OutcomeTarget = { kind: "record" } | { kind: "edit"; outcome: Outcome }

/**
 * "Record Outcome" and "Edit" (F9 step 4): one dialog with a required type.
 * The list refetches once the save succeeds ("Outcome saved."); a failure is
 * C-ERR-2 and the dialog stays open with its value.
 */
export function useRecordOutcome(applicationId: string) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<OutcomeTarget | null>(null)
  const mutation = useMutation({
    mutationFn: async ({ target, type }: { target: OutcomeTarget; type: OutcomeType }) => {
      const csrfToken = await ensureCsrfToken(queryClient)
      return target.kind === "record" ? recordOutcome(applicationId, type, csrfToken) : editOutcome(target.outcome.id, type, csrfToken)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...outcomesQueryKey, applicationId] })
      setTarget(null)
      toastSuccess(outcomeCopy.saved)
    },
    onError: () => toastActionFailed("save the Outcome"),
  })
  return {
    target,
    open: setTarget,
    close: () => !mutation.isPending && setTarget(null),
    isSaving: mutation.isPending,
    save: (type: OutcomeType) => target && mutation.mutate({ target, type }),
  }
}
