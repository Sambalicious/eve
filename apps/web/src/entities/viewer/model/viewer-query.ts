import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"

import { fetchViewer } from "../api/viewer-repository"
import { SAFE_VIEWER, type Viewer } from "./viewer"

export const viewerQueryKey = ["viewer"] as const

/** Like the session: five minutes. A write replaces the cache with the server's body. */
export function viewerQueryOptions() {
  return queryOptions({
    queryKey: viewerQueryKey,
    queryFn: fetchViewer,
    staleTime: 5 * 60 * 1000,
    retry: false,
    // A failed read stays failed (safe view) until a reload: a refetch on every mount would flip the shell back to its loading state.
    retryOnMount: false,
  })
}

/** The viewer, or the safe view while unread or after a failed read. */
export function useViewer(): Viewer {
  return useQuery(viewerQueryOptions()).data ?? SAFE_VIEWER
}

export function useSetViewer() {
  const queryClient = useQueryClient()
  return (viewer: Viewer) => queryClient.setQueryData(viewerQueryKey, viewer)
}
