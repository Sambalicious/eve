import { queryOptions } from "@tanstack/react-query"

import { fetchCandidateSettings } from "../api/candidate-settings-repository"

export const candidateSettingsQueryKey = ["candidate-settings"] as const

export function candidateSettingsQueryOptions() {
  return queryOptions({ queryKey: candidateSettingsQueryKey, queryFn: fetchCandidateSettings })
}
