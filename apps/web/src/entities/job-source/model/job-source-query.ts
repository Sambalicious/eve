import { queryOptions } from "@tanstack/react-query"

import { fetchJobSources } from "../api/job-source-repository"

export const jobSourcesQueryKey = ["job-sources"] as const

export function jobSourcesQueryOptions() {
  return queryOptions({ queryKey: jobSourcesQueryKey, queryFn: fetchJobSources })
}
