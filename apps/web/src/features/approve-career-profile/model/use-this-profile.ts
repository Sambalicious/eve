import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"

import { approveDraft, careerProfileQueryKey, emptyFactIds, uploadCopy, type ProfileVersion } from "@/entities/career-profile"
import { contactQueryKey, saveContactDetails, type ContactDetails } from "@/entities/candidate-settings"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

/**
 * "Use this profile" on the Upload screen (R2, AC-2.3): saves the contact full name when the
 * Candidate changed it or none is stored (generation refuses without one), then approves the
 * draft through the existing endpoint and goes to Home. Nothing is approved implicitly.
 */
export function useUseThisProfile(draft: ProfileVersion, contact: ContactDetails | undefined) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [refusedFactIds, setRefusedFactIds] = useState<readonly string[]>([])
  const mutation = useMutation({
    mutationFn: async (fullName: string) => {
      const csrf = await ensureCsrfToken(queryClient)
      if (contact?.fullName !== fullName) {
        const saved = await saveContactDetails({ fullName, lines: [...(contact?.lines ?? [])] }, csrf)
        queryClient.setQueryData(contactQueryKey, saved)
      }
      return approveDraft(draft.version, csrf)
    },
    onSuccess: (profile) => {
      queryClient.setQueryData(careerProfileQueryKey, profile)
      toastSuccess(uploadCopy.toastConfirmed)
      void navigate("/dashboard")
    },
    onError: () => toastActionFailed("use this profile"),
  })
  return {
    isPending: mutation.isPending,
    refusedFactIds,
    use: (fullName: string) => {
      const empty = emptyFactIds(draft)
      setRefusedFactIds(empty)
      if (empty.length === 0) mutation.mutate(fullName)
    },
  }
}
