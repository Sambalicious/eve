import { queryOptions } from "@tanstack/react-query"

import { fetchHiringHintTerms } from "../api/hiring-search-inputs-repository"

export const hiringHintTermsQueryKey = ["stack-posts", "hiring-search-inputs"] as const

/** Read once per page load, like Job criteria (AC 3.8): a settings save shows on the next load. */
export function hiringHintTermsQueryOptions() {
  return queryOptions({ queryKey: hiringHintTermsQueryKey, queryFn: fetchHiringHintTerms })
}
