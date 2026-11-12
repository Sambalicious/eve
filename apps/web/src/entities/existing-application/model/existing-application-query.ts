import { queryOptions } from "@tanstack/react-query"

import { fetchExistingApplications } from "../api/existing-application-repository"

export const existingApplicationsQueryKey = ["existing-applications"] as const

export function existingApplicationsQueryOptions() {
  return queryOptions({
    queryKey: existingApplicationsQueryKey,
    queryFn: fetchExistingApplications,
  })
}
