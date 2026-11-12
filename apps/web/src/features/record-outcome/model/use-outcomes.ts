import { useQuery } from "@tanstack/react-query"

import { outcomesQueryOptions, type Outcome } from "@/entities/outcome"

/** The Application's Outcomes, oldest first. */
export function useOutcomes(applicationId: string): { outcomes: readonly Outcome[] | undefined; isError: boolean; retry: () => void } {
  const query = useQuery(outcomesQueryOptions(applicationId))
  return { outcomes: query.data, isError: query.isError, retry: () => void query.refetch() }
}
