import { queryOptions } from "@tanstack/react-query"

import { automationStateQueryOptions } from "@/entities/automation-state"

import { fetchOutreach } from "../api/outreach-repository"

export const outreachQueryKey = ["outreach"] as const

/** `api-contract.md` 4.2: poll every 2,000 ms while any item is running, then stop. */
export const OUTREACH_POLL_MS = 2_000

/**
 * The three items and the approved profile version for one Application. A
 * failed background poll keeps the last good data on screen (React Query keeps
 * `data`), so the section only shows its load error when there is no data yet.
 */
export function outreachQueryOptions(applicationId: string) {
  return queryOptions({
    queryKey: [...outreachQueryKey, applicationId],
    queryFn: () => fetchOutreach(applicationId),
    refetchInterval: (query) => (query.state.data?.items.some((item) => item.status === "running") === true ? OUTREACH_POLL_MS : false),
  })
}

/** The pause state the section reads (G5: the shell banner owns the Resume control). */
export function outreachPauseQueryOptions() {
  return automationStateQueryOptions()
}
