import { useMutation, useQueryClient } from "@tanstack/react-query"

import { applicationsQueryKey } from "@/entities/application"
import { clearRequisitionRecord, recordCopy, requisitionRecordsQueryKey } from "@/entities/requisition-record"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

/** Clears a minimal record (C-CONFIRM-13, toast C-DATA-5). The requisition can then be applied to again. */
export function useClearRecord({ onCleared }: { onCleared: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (applicationId: string) => clearRequisitionRecord(applicationId, await ensureCsrfToken(queryClient)),
    onSuccess: async () => {
      onCleared()
      toastSuccess(recordCopy.clearedToast)
      await Promise.all([requisitionRecordsQueryKey, applicationsQueryKey].map((queryKey) => queryClient.invalidateQueries({ queryKey })))
    },
    onError: () => toastActionFailed("clear the record"),
  })
  return { clear: mutation.mutate, isClearing: mutation.isPending }
}
