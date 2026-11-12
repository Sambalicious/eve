import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { isAdvancedOn, setAdvanced, useSetViewer, useViewer } from "@/entities/viewer"
import { toastSuccess } from "@/shared/lib/action-failed"
import { advancedCopy } from "./copy"

/**
 * The Advanced switch (R3): one `PUT /v1/me/advanced`, written into the `viewer` cache from the
 * server's body so the nav re-derives in the same render. A 409 `advanced_locked` means a stale tab:
 * the viewer is refetched and the lock note shows.
 */
export function useToggleAdvanced() {
  const queryClient = useQueryClient()
  const viewer = useViewer()
  const setViewer = useSetViewer()
  const [failed, setFailed] = useState(false)
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => setAdvanced(enabled, await ensureCsrfToken(queryClient)),
    onMutate: () => setFailed(false),
    onSuccess: (next) => {
      setViewer(next)
      toastSuccess(next.advancedEnabled ? advancedCopy.toastOn : advancedCopy.toastOff)
    },
    onError: (error) => {
      setFailed(true)
      if (hasErrorCode(error, "advanced_locked")) void queryClient.invalidateQueries({ queryKey: ["viewer"] })
    },
  })
  return {
    checked: isAdvancedOn(viewer),
    locked: viewer.advancedLocked,
    isPending: mutation.isPending,
    failed,
    toggle: (enabled: boolean) => mutation.mutate(enabled),
  }
}
