import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { CandidateContact } from "@eve/contracts"

import { contactQueryKey, saveContactDetails } from "@/entities/candidate-settings"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

export function useSaveContactDetails() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (contact: CandidateContact) => saveContactDetails(contact, await ensureCsrfToken(queryClient)),
    onSuccess: (saved) => {
      queryClient.setQueryData(contactQueryKey, saved)
      toastSuccess("Saved.")
    },
    onError: () => toastActionFailed("save your contact details"),
  })
  return { save: mutation.mutate, isSaving: mutation.isPending }
}
