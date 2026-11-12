import { useQuery } from "@tanstack/react-query"

import { automationStateQueryOptions, type AutomationState } from "@/entities/automation-state"

/** The banner's data: the global pause and the cost pause, polled every 30 s. A failed read shows no banner. */
export function useAutomationBanner(): AutomationState | undefined {
  return useQuery(automationStateQueryOptions()).data
}
