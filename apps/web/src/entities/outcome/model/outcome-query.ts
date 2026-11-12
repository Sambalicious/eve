import { queryOptions } from "@tanstack/react-query"

import { fetchOutcomes } from "../api/outcome-repository"

export const outcomesQueryKey = ["outcomes"] as const

export function outcomesQueryOptions(applicationId: string) {
  return queryOptions({ queryKey: [...outcomesQueryKey, applicationId], queryFn: () => fetchOutcomes(applicationId) })
}
