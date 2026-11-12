import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { submissionQueryKey } from "@/entities/application"
import { automationCopy, automationStateQueryKey, automationStateQueryOptions, setGlobalPause } from "@/entities/automation-state"
import { ensureCsrfToken } from "@/entities/session"
import { alertFeedsQueryKey, hiringAlertFeedsQueryKey } from "@/entities/stack-post"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

const p = automationCopy.pause

/**
 * The global pause (F10): pausing is immediate (toast C-PAUSE-1); resuming
 * confirms with C-CONFIRM-10 first (toast C-PAUSE-3). Neither touches the cost
 * pause. Submission status and both feeds lists (the Alert feeds and Hiring
 * Alert feeds pause notes, EPIC-0008 OWN-1) carry `globalPaused` too, so they
 * are refetched and the notes follow without a reload.
 */
export function useGlobalPause() {
  const queryClient = useQueryClient()
  const state = useQuery(automationStateQueryOptions())
  const [confirmingResume, setConfirmingResume] = useState(false)
  const mutation = useMutation({
    mutationFn: async (paused: boolean) => setGlobalPause(paused, await ensureCsrfToken(queryClient)),
    onSuccess: (next) => {
      queryClient.setQueryData(automationStateQueryKey, next)
      for (const queryKey of [submissionQueryKey, alertFeedsQueryKey, hiringAlertFeedsQueryKey]) void queryClient.invalidateQueries({ queryKey })
      setConfirmingResume(false)
      toastSuccess(next.globalPaused ? p.paused : p.resumed)
    },
    onError: (_error, paused) => {
      setConfirmingResume(false)
      toastActionFailed(paused ? "pause automation" : "resume automation")
    },
  })
  return {
    /** Null until the controls have loaded: the control isn't shown before then. */
    isPaused: state.data?.globalPaused ?? null,
    isPending: mutation.isPending,
    pause: () => mutation.mutate(true),
    askResume: () => setConfirmingResume(true),
    confirmingResume,
    setConfirmingResume,
    resume: () => mutation.mutate(false),
  }
}
