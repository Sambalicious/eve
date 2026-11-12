import { useMutation, useQueryClient } from "@tanstack/react-query"

import { applicationsQueryKey, documentsListQueryKey } from "@/entities/application"
import { outcomesQueryKey } from "@/entities/outcome"
import { deleteDetailedRecords, PartialDeletionError, recordCopy, requisitionRecordsQueryKey } from "@/entities/requisition-record"
import { retentionQueryKey } from "@/entities/retention"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"
import { toastActionFailed, toastError, toastSuccess } from "@/shared/lib/action-failed"

/**
 * Deletes detailed records for one or many Applications (F10 retention, AC
 * 10.3), then refetches every list that showed them. Toast C-DATA-4 with the
 * backend's count. The Retention counts on `/privacy` refetch too (v1.17.0). A refusal (an attempt in flight, an unknown ID) deleted
 * nothing, so its contract message is shown; other failures are C-ERR-2.
 * More than 100 IDs go in batches of 100 (CR7-01). If a later batch fails, the
 * earlier batches' deletions are real: refetch, toast C-DATA-4 with that count,
 * then the failure.
 */
export function useDeleteDetailedRecords({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const invalidate = () =>
    Promise.all(
      [applicationsQueryKey, documentsListQueryKey, outcomesQueryKey, requisitionRecordsQueryKey, retentionQueryKey].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
    )
  const mutation = useMutation({
    mutationFn: async (ids: readonly string[]) => deleteDetailedRecords(ids, await ensureCsrfToken(queryClient)),
    onSuccess: async (deletedCount) => {
      await invalidate()
      onDone()
      toastSuccess(recordCopy.deletedToast(deletedCount))
    },
    onError: async (error) => {
      onDone()
      if (error instanceof PartialDeletionError) {
        await invalidate()
        toastSuccess(recordCopy.deletedToast(error.deletedCount))
        // OPEN[designer]: no copy for "some batches deleted, the rest failed".
        return toastError(isRefusal(error.cause) ? error.cause.message : recordCopy.restNotDeleted)
      }
      if (isRefusal(error)) return toastError(error.message)
      toastActionFailed("delete the detailed records")
    },
  })
  return { remove: mutation.mutate, isDeleting: mutation.isPending }
}

function isRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === "application_state_conflict" || error.code === "not_found")
}
