import { queryOptions } from "@tanstack/react-query"

import { fetchAiProvider } from "../api/ai-provider-repository"

export const aiProviderQueryKey = ["ai-provider"] as const

export function aiProviderQueryOptions() {
  return queryOptions({ queryKey: aiProviderQueryKey, queryFn: fetchAiProvider })
}
