import { useQuery } from "@tanstack/react-query"

import { automationStateQueryOptions, type AutomationState } from "@/entities/automation-state"

/** Controls for the Monthly cost section; polled with the rest of the automation state. */
export function useAutomationState(): { data: AutomationState | undefined; isError: boolean; retry: () => void } {
  const query = useQuery(automationStateQueryOptions())
  return { data: query.data, isError: query.isError, retry: () => void query.refetch() }
}
