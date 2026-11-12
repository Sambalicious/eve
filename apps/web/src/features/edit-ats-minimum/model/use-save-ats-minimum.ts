import { useMutation, useQueryClient } from "@tanstack/react-query"

import { atsMinimumQueryKey, saveAtsMinimum } from "@/entities/candidate-settings"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

export function useSaveAtsMinimum() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (minAtsPercent: number) => saveAtsMinimum(minAtsPercent, await ensureCsrfToken(queryClient)),
    onSuccess: (saved) => {
      queryClient.setQueryData(atsMinimumQueryKey, saved)
      // A lower minimum can release held Applications back to the queue.
      void queryClient.invalidateQueries({ queryKey: ["submissions"] })
      toastSuccess("Saved.")
    },
    onError: () => toastActionFailed("save your ATS minimum"),
  })
  return { save: mutation.mutate, isSaving: mutation.isPending }
}
