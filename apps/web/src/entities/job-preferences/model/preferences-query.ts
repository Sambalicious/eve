import { queryOptions } from "@tanstack/react-query"

import { fetchPreferences } from "../api/preferences-repository"

export const preferencesQueryKey = ["job-preferences"] as const

export function preferencesQueryOptions() {
  return queryOptions({ queryKey: preferencesQueryKey, queryFn: fetchPreferences })
}
