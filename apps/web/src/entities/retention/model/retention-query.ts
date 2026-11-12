import { queryOptions } from "@tanstack/react-query"

import { fetchRetention } from "../api/retention-repository"

export const retentionQueryKey = ["retention"] as const

/** Fetched on page load and window focus (design spec §6, Real-time); no polling. */
export function retentionQueryOptions() {
  return queryOptions({ queryKey: retentionQueryKey, queryFn: fetchRetention })
}
