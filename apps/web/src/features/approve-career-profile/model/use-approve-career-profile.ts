import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  approveDraft,
  careerProfileCopy,
  careerProfileQueryKey,
  emptyFactIds,
  type ProfileVersion,
} from "@/entities/career-profile"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

/**
 * Approve a draft version: version 1 confirms with C-CONFIRM-1, later versions
 * with C-CONFIRM-16. A draft with an empty fact is not sent; the empty facts
 * get C-VAL-PROFILE-2 instead. The backend's 422 has the same result.
 */
export function useApproveCareerProfile(draft: ProfileVersion) {
  const queryClient = useQueryClient()
  const [isConfirming, setIsConfirming] = useState(false)
  const [refusedFactIds, setRefusedFactIds] = useState<readonly string[]>([])

  const mutation = useMutation({
    mutationFn: async () => approveDraft(draft.version, await ensureCsrfToken(queryClient)),
    onSuccess: (profile) => {
      queryClient.setQueryData(careerProfileQueryKey, profile)
      setIsConfirming(false)
      toastSuccess(careerProfileCopy.versionApproved(draft.version))
    },
    onError: (error) => {
      setIsConfirming(false)
      if (hasErrorCode(error, "career_profile_fact_empty")) {
        setRefusedFactIds(emptyFactIds(draft))
        return
      }
      toastActionFailed(`approve version ${draft.version}`)
    },
  })

  const requestApproval = () => {
    const empty = emptyFactIds(draft)
    setRefusedFactIds(empty)
    if (empty.length === 0) setIsConfirming(true)
  }

  return {
    requestApproval,
    isConfirming,
    setIsConfirming,
    confirm: () => mutation.mutate(),
    isApproving: mutation.isPending,
    refusedFactIds,
  }
}
