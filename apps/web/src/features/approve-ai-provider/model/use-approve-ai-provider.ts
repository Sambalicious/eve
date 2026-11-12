import { useMutation, useQueryClient } from "@tanstack/react-query"

import { aiProviderQueryKey, approveAiProvider } from "@/entities/ai-provider"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed } from "@/shared/lib/action-failed"

/**
 * Approves Anthropic under the terms version shown. Only the confirm in
 * C-CONFIRM-15 calls `approve`; cancelling sends nothing.
 */
export function useApproveAiProvider({ onApproved }: { onApproved: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (termsCheckedOn: string) =>
      approveAiProvider(termsCheckedOn, await ensureCsrfToken(queryClient)),
    onSuccess: (provider) => {
      queryClient.setQueryData(aiProviderQueryKey, provider)
      onApproved()
    },
    onError: () => toastActionFailed("approve Anthropic"),
  })
  return { approve: mutation.mutate, isApproving: mutation.isPending }
}
