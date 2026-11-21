import { queryOptions } from "@tanstack/react-query"

import type { AddedFactsView } from "@eve/contracts"

import { fetchAddedFacts } from "../api/added-facts-repository"

/** One view per Application; a write replaces it with the response's `view` (or a refetch after a 409). */
export const addedFactsQueryKey = (applicationId: string) => ["added-facts", applicationId] as const

/** While documents generate, the page already polls the detail; the view follows at the same pace. */
export const ADDED_FACTS_POLL_MS = 5_000

/**
 * The view embedded in `GET /v1/applications/{id}` seeds the first render (`placeholderData`), so the
 * page needs no second spinner. With the flag off the detail carries no `addedFacts` key and the query
 * stays disabled: the page then shows today's ATS card and no Added section.
 */
export function addedFactsQueryOptions(applicationId: string, placeholder: AddedFactsView | undefined) {
  return queryOptions({
    queryKey: addedFactsQueryKey(applicationId),
    queryFn: () => fetchAddedFacts(applicationId),
    enabled: placeholder !== undefined,
    placeholderData: placeholder,
    refetchInterval: (query) => (query.state.data?.busyReason === "generating" ? ADDED_FACTS_POLL_MS : false),
  })
}
