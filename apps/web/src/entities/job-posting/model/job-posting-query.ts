import { infiniteQueryOptions, queryOptions, type InfiniteData } from "@tanstack/react-query"

import { fetchJobPosting, fetchJobPostingsPage } from "../api/job-posting-repository"
import type { JobPostingPage, PostingFilter, PostingsTab } from "./job-posting"

export const jobPostingsQueryKey = ["job-postings"] as const

/** Transient items poll every 5 s until they settle (design-spec, Real-time updates). */
export const CHECKING_POLL_MS = 5_000

export function jobPostingsListQueryKey(tab: PostingsTab, filter: PostingFilter) {
  return [...jobPostingsQueryKey, "list", tab, filter.families.join(","), filter.keyword ?? ""] as const
}

/**
 * The pages of one tab under one Posting filter, 25 rows a page (v1.12.0).
 * The page param is the previous page's `nextCursor`; the first page has none.
 *
 * Polling: while any loaded row is "Checking", the query refetches every 5 s.
 * React Query refetches an infinite query from page 1 and follows the fresh
 * `nextCursor` of each page, for as many pages as are loaded, so a poll keeps
 * the number of loaded pages, updates rows in place, drops rows that left the
 * tab, and stops early when the data now fits in fewer pages.
 */
export function jobPostingsInfiniteQueryOptions(tab: PostingsTab, filter: PostingFilter) {
  return infiniteQueryOptions({
    queryKey: jobPostingsListQueryKey(tab, filter),
    queryFn: ({ pageParam }) => fetchJobPostingsPage({ tab, filter, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchInterval: (query) => (hasChecking(query.state.data) ? CHECKING_POLL_MS : false),
  })
}

/**
 * "Does any Job Posting exist at all?" for the first-run empty state: one
 * unfiltered All-tab row, read for its `totalCount` (design addendum note 4).
 */
export function anyJobPostingQueryOptions() {
  return queryOptions({
    queryKey: [...jobPostingsQueryKey, "any"],
    queryFn: () => fetchJobPostingsPage({ tab: "all", limit: 1 }),
    select: (page) => page.totalCount > 0,
  })
}

export function jobPostingQueryOptions(id: string) {
  return queryOptions({
    queryKey: [...jobPostingsQueryKey, "detail", id],
    queryFn: () => fetchJobPosting(id),
    refetchInterval: (query) => (query.state.data?.status === "checking" ? CHECKING_POLL_MS : false),
  })
}

function hasChecking(data: InfiniteData<JobPostingPage, string | null> | undefined): boolean {
  return data?.pages.some((page) => page.postings.some((p) => p.status === "checking")) ?? false
}
