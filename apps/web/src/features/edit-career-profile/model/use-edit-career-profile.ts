import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  careerProfileCopy,
  careerProfileQueryKey,
  discardDraft,
  saveDraft,
  type CareerProfile,
  type DraftContent,
} from "@/entities/career-profile"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"
import { toast } from "@/shared/ui/toast"

/**
 * "Save draft": creates version n+1 from the version in use, or updates the
 * one draft. A save refused while drafting runs shows C-PROFILE-14 as an error
 * toast, and the editor keeps the edits (design-spec.r3 F1).
 */
export function useSaveDraft({ onSaved }: { onSaved: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (content: DraftContent) => saveDraft(content, await ensureCsrfToken(queryClient)),
    onSuccess: async (draft) => {
      await queryClient.invalidateQueries({ queryKey: careerProfileQueryKey })
      toastSuccess(careerProfileCopy.draftSaved(draft.version))
      onSaved()
    },
    onError: (error) => {
      if (hasErrorCode(error, "resume_drafting_in_progress")) {
        const filename = queryClient.getQueryData<CareerProfile>(careerProfileQueryKey)?.drafting?.filename ?? null
        toast.error(careerProfileCopy.stillDrafting(filename))
        void queryClient.invalidateQueries({ queryKey: careerProfileQueryKey })
        return
      }
      toastActionFailed("save the draft")
    },
  })
  return { save: mutation.mutate, isSaving: mutation.isPending }
}

/** "Discard draft" after C-CONFIRM-17. The approved version stays in use. */
export function useDiscardDraft(version: number) {
  const queryClient = useQueryClient()
  const [isConfirming, setIsConfirming] = useState(false)
  const mutation = useMutation({
    mutationFn: async () => discardDraft(version, await ensureCsrfToken(queryClient)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: careerProfileQueryKey })
      setIsConfirming(false)
    },
    onError: (error) => {
      setIsConfirming(false)
      if (hasErrorCode(error, "not_found")) {
        void queryClient.invalidateQueries({ queryKey: careerProfileQueryKey })
        return
      }
      toastActionFailed("discard the draft")
    },
  })
  return { isConfirming, setIsConfirming, discard: () => mutation.mutate(), isDiscarding: mutation.isPending }
}
