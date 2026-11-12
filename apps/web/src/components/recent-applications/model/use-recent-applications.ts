import { useQuery } from "@tanstack/react-query"

import { applicationsQueryOptions } from "@/entities/application"

const RECENT_MAX = 5

/** At most five Applications, newest first (AC-1.4). */
export function useRecentApplications() {
  const query = useQuery(applicationsQueryOptions())
  const rows = [...(query.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_MAX)
  return { rows, isLoading: !query.data && !query.isError, isError: query.isError, retry: () => void query.refetch() }
}
