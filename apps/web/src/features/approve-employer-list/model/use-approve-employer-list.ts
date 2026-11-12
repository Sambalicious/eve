import { useMutation, useQueryClient } from "@tanstack/react-query"

import { approveEmployerList, jobSourceCopy, jobSourcesQueryKey } from "@/entities/job-source"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

/** Approves the whole employer list. Only the confirm in C-CONFIRM-20 calls `approve`. */
export function useApproveEmployerList({ onApproved }: { onApproved: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () => approveEmployerList(await ensureCsrfToken(queryClient)),
    onSuccess: (sources) => {
      queryClient.setQueryData(jobSourcesQueryKey, sources)
      toastSuccess(jobSourceCopy.approvedToast)
      onApproved()
    },
    onError: () => toastActionFailed("approve the employer list"),
  })
  return { approve: () => mutation.mutate(), isApproving: mutation.isPending }
}
