import { useMutation, useQueryClient } from "@tanstack/react-query"

import { applicationsQueryKey, documentsListQueryKey, generateDocuments } from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { toastActionFailed } from "@/shared/lib/action-failed"

/**
 * Starts (or restarts) generation. `contact_details_missing` is reported to
 * the caller, which shows it inline with a link to the form; other failures
 * toast C-ERR-2. On success the detail refetches and polls while generating.
 */
export function useGenerateDocuments(applicationId: string, { onContactMissing }: { onContactMissing: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () => generateDocuments(applicationId, await ensureCsrfToken(queryClient)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: applicationsQueryKey })
      void queryClient.invalidateQueries({ queryKey: documentsListQueryKey })
    },
    onError: (error) => {
      if (hasErrorCode(error, "contact_details_missing")) return onContactMissing()
      toastActionFailed("generate the documents")
    },
  })
  return { generate: () => mutation.mutate(), isStarting: mutation.isPending }
}
