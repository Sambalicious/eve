import { useQuery } from "@tanstack/react-query"

import { aiProviderQueryOptions } from "@/entities/ai-provider"
import { uploadCopy } from "@/entities/career-profile"
import { useViewer } from "@/entities/viewer"
import { toastSuccess } from "@/shared/lib/action-failed"
import { useApproveAiProvider } from "./use-approve-ai-provider"

/** Which consent line the Upload screen shows, chosen by role and approval (AC-2.2, AC-2.2a). */
export function useConsent(onApproved?: () => void) {
  const provider = useQuery(aiProviderQueryOptions())
  const { isOperator } = useViewer()
  const { approve, isApproving } = useApproveAiProvider({
    onApproved: () => {
      toastSuccess(uploadCopy.toastConsent)
      onApproved?.()
    },
  })
  return {
    ready: provider.data !== undefined,
    approved: provider.data?.approval != null,
    isOperator,
    isApproving,
    approve: () => provider.data && approve(provider.data.terms.checkedOn),
  }
}
