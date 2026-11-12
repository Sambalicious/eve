import { queryOptions } from "@tanstack/react-query"

import { fetchHiringAlertFeeds, fetchHiringPosts } from "../api/hiring-repository"
import { fetchAlertFeeds, fetchStackPosts } from "../api/stack-post-repository"

export const alertFeedsQueryKey = ["stack-posts", "alert-feeds"] as const
export const stackPostsQueryKey = ["stack-posts", "posts"] as const

export function alertFeedsQueryOptions() {
  return queryOptions({ queryKey: alertFeedsQueryKey, queryFn: fetchAlertFeeds })
}

/** One page of Stack posts. The previous page stays on screen while the next loads (design-spec F6 step 3). */
export function stackPostsQueryOptions(page: number) {
  return queryOptions({
    queryKey: [...stackPostsQueryKey, page] as const,
    queryFn: () => fetchStackPosts(page),
    placeholderData: (previous) => previous,
  })
}

/** EPIC-0007 Phase 3: the session Candidate's own Hiring Alert feeds and permitted-use record. */
export const hiringAlertFeedsQueryKey = ["stack-posts", "hiring-feeds"] as const
export const hiringPostsQueryKey = ["stack-posts", "hiring-posts"] as const

export function hiringAlertFeedsQueryOptions() {
  return queryOptions({ queryKey: hiringAlertFeedsQueryKey, queryFn: fetchHiringAlertFeeds })
}

/** One page of Hiring posts; the previous page stays on screen while the next loads (design-spec r2 H7 step 6). */
export function hiringPostsQueryOptions(page: number) {
  return queryOptions({
    queryKey: [...hiringPostsQueryKey, page] as const,
    queryFn: () => fetchHiringPosts(page),
    placeholderData: (previous) => previous,
  })
}
