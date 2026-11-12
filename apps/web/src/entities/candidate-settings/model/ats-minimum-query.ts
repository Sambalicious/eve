import { queryOptions } from "@tanstack/react-query"

import { fetchAtsMinimum } from "../api/ats-minimum-repository"

export const atsMinimumQueryKey = ["ats-minimum"] as const

export function atsMinimumQueryOptions() {
  return queryOptions({ queryKey: atsMinimumQueryKey, queryFn: fetchAtsMinimum })
}
