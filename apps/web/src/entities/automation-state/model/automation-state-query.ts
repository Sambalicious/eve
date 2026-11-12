import { queryOptions } from "@tanstack/react-query"

import { fetchAutomationState } from "../api/automation-state-repository"

export const automationStateQueryKey = ["automation-state"] as const

/** Automation state polls every 30 s while the tab is visible, and on focus (design-spec, Real-time updates). */
export const AUTOMATION_POLL_MS = 30_000

export function automationStateQueryOptions() {
  return queryOptions({ queryKey: automationStateQueryKey, queryFn: fetchAutomationState, refetchInterval: AUTOMATION_POLL_MS })
}
