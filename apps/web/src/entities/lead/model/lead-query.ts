import { queryOptions } from "@tanstack/react-query"

import { fetchLeads } from "../api/lead-repository"

export const leadsQueryKey = ["leads"] as const

export function leadsQueryOptions() {
  return queryOptions({ queryKey: leadsQueryKey, queryFn: fetchLeads, meta: { errorMessage: "Couldn't load your pipeline. Try again." } })
}
