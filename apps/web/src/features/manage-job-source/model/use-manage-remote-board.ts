import { useMutation, useQueryClient } from "@tanstack/react-query"

import { jobSourcesQueryKey, setRemoteBoardEnabled, verifyRemoteBoard, type RemoteBoardKey } from "@/entities/job-source"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { toastActionFailed } from "@/shared/lib/action-failed"

/**
 * Enables or disables a remote board. A `job_source_not_verified` refusal
 * calls `onRefused` so the row shows C-SRC-3 inline; the switch stays put
 * because the cached state doesn't change.
 */
export function useSetRemoteBoardEnabled({ onRefused }: { onRefused: (key: RemoteBoardKey) => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async ({ key, enabled }: { key: RemoteBoardKey; enabled: boolean }) =>
      setRemoteBoardEnabled(key, enabled, await ensureCsrfToken(queryClient)),
    onSuccess: (sources) => queryClient.setQueryData(jobSourcesQueryKey, sources),
    onError: (error, { key, enabled }) => {
      if (hasErrorCode(error, "job_source_not_verified")) return onRefused(key)
      toastActionFailed(enabled ? "enable this Job Source" : "disable this Job Source")
    },
  })
  return { setEnabled: mutation.mutate, pendingKey: mutation.isPending ? mutation.variables?.key : undefined }
}

export function useVerifyRemoteBoard({ onVerified }: { onVerified: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async ({ key, verifiedOn, basis }: { key: RemoteBoardKey; verifiedOn: string; basis: string }) =>
      verifyRemoteBoard(key, { verifiedOn, basis }, await ensureCsrfToken(queryClient)),
    onSuccess: (sources) => {
      queryClient.setQueryData(jobSourcesQueryKey, sources)
      onVerified()
    },
    onError: () => toastActionFailed("mark this Job Source verified"),
  })
  return { verify: mutation.mutate, isVerifying: mutation.isPending }
}
