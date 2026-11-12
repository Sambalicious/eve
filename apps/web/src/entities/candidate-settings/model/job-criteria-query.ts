import { queryOptions } from "@tanstack/react-query"

import { fetchJobCriteria } from "../api/job-criteria-repository"

export const jobCriteriaQueryKey = ["job-criteria"] as const

export function jobCriteriaQueryOptions() {
  return queryOptions({ queryKey: jobCriteriaQueryKey, queryFn: fetchJobCriteria })
}
