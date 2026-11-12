import { useMutation, useQueryClient } from "@tanstack/react-query"

import { submissionQueryKey } from "@/entities/application"
import {
  completeExistingApplications,
  existingApplicationCopy as c,
  existingApplicationsQueryKey,
} from "@/entities/existing-application"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed } from "@/shared/lib/action-failed"

/**
 * Marks the existing-applications step complete (C-CONFIRM-2). Afterwards the
 * submission status refetches, so the Activation Gate row and Home's status
 * card show the step done. A failure is a C-ERR-2 toast and the dialog stays.
 */
export function useCompleteExistingApplications({
  onCompleted,
}: {
  onCompleted: () => void
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () =>
      completeExistingApplications(await ensureCsrfToken(queryClient)),
    onSuccess: (list) => {
      queryClient.setQueryData(existingApplicationsQueryKey, list)
      void queryClient.invalidateQueries({ queryKey: submissionQueryKey })
      onCompleted()
    },
    onError: () => toastActionFailed(c.failedActions.complete),
  })
  return { complete: () => mutation.mutate(), isCompleting: mutation.isPending }
}
