import { useEffect, useRef, useState, type RefObject } from "react"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"

import { focusPostingTitle } from "@/components/posting-list"
import {
  anyJobPostingQueryOptions,
  countLine as formatCountLine,
  formatCopy,
  isPostingFilterActive,
  jobPostingsInfiniteQueryOptions,
  loadedAnnouncement,
  loadedPostings,
  postingsCopy,
  type JobPostingPage,
  type PostingsTab,
} from "@/entities/job-posting"
import { API_TABS, NO_FILTER, usePostingsUrl } from "@/features/filter-postings"
import { ApiError } from "@/shared/api"
import { useAnnouncer } from "@/shared/lib/use-announcer"

/**
 * View model of the Job Postings page (design addendum F4-8a to F4-8f): the
 * URL view, the paged list, Load more with its failure and restart rules,
 * focus after a page loads, and the status-region announcements.
 *
 * Polling (rows in "Checking", every CHECKING_POLL_MS) refetches every loaded
 * page from page 1 with fresh cursors (see jobPostingsInfiniteQueryOptions). It
 * keeps the number of loaded pages, never dims, never moves focus and never
 * announces; only a tab or filter change, or Load more, does those.
 */
export function usePostingsView({
  listRef,
  searchRef,
  apiTab,
  enabled = true,
}: {
  listRef: RefObject<HTMLElement | null>
  searchRef: RefObject<HTMLInputElement | null>
  /** The API tab to read; defaults to the first one behind the URL's tab. Not a match reads a second one for its stacked section. */
  apiTab?: PostingsTab
  enabled?: boolean
}) {
  const queryClient = useQueryClient()
  const { tab: webTab, filter, setTab, setFilter } = usePostingsUrl()
  const tab: PostingsTab = apiTab ?? API_TABS[webTab][0]
  const options = jobPostingsInfiniteQueryOptions(tab, filter)
  const list = useInfiniteQuery({ ...options, placeholderData: (previous) => previous, enabled })
  const { message, announce } = useAnnouncer()
  const [isRestarting, setIsRestarting] = useState(false)
  const pendingFocus = useRef<string | null>(null)

  const pages: readonly JobPostingPage[] = list.data?.pages ?? []
  const rows = loadedPostings(pages)
  const latest = pages.at(-1)
  const isFiltered = isPostingFilterActive(filter)
  const isPlaceholder = list.isPlaceholderData
  // From the shown page, not `list.hasNextPage`: while the previous view's rows
  // show as placeholder data, Load more stays in place (aria-disabled) rather than vanishing.
  const hasMore = latest?.nextCursor != null
  const countLine = latest
    ? formatCountLine({ total: latest.totalCount, loaded: rows.length, hasMore, filtered: isFiltered })
    : null

  // "Does any visible posting exist on any tab?" decides first run, Ranked empty and (v1.18.0) all hidden.
  // On All, the unfiltered page answers it; elsewhere a one-row All read does.
  const needsAnyCheck =
    !isFiltered &&
    tab !== "all" &&
    !!latest &&
    rows.length === 0 &&
    !isPlaceholder
  const any = useQuery({ ...anyJobPostingQueryOptions(), enabled: needsAnyCheck })

  // What a settled view shows (design-spec r2 B2), or undefined while it isn't settled: a
  // placeholder load, or the first-run check still pending. Until then the last settled
  // content stays on screen, dimmed (finding-r3-empty-flash), so no other empty state flashes.
  const current = settledContent({ latest, rows: rows.length, isPlaceholder, isFiltered, tab, anyPending: any.isPending, anyExists: any.data })
  const [lastSettled, setLastSettled] = useState<PostingsContent | undefined>(current)
  if (current !== undefined && current !== lastSettled) setLastSettled(current)
  const shown = current ?? lastSettled

  // A settled tab or filter change announces the new count, or the filter empty state's title.
  const viewKey = options.queryKey.join("|")
  const announcedKey = useRef(viewKey)
  useEffect(() => {
    if (viewKey === announcedKey.current || !latest || isPlaceholder) return
    announcedKey.current = viewKey
    if (latest.totalCount > 0 && countLine) announce(formatCopy(postingsCopy.announce.viewSettled, { countLine }))
    else if (isFiltered) announce(postingsCopy.announce.filterEmpty)
  }, [viewKey, latest, isPlaceholder, isFiltered, countLine, announce])

  // Focus waits for the new rows to render.
  useEffect(() => {
    if (pendingFocus.current && listRef.current && focusPostingTitle(listRef.current, pendingFocus.current)) {
      pendingFocus.current = null
    }
  })

  const loadMoreError = list.isFetchNextPageError
  const isStaleCursor = loadMoreError && list.error instanceof ApiError && list.error.status === 400
  const isLoadingMore = list.isFetchingNextPage || isRestarting
  const isLoadMoreBusy = isLoadingMore || isPlaceholder

  async function loadMore() {
    if (isLoadMoreBusy || !hasMore) return
    if (isStaleCursor) return restart()
    const shown = new Set(rows.map((p) => p.id))
    const result = await list.fetchNextPage({ cancelRefetch: false })
    if (result.isFetchNextPageError || !result.data) return announce(postingsCopy.announce.loadFailed)
    const after = loadedPostings(result.data.pages)
    const added = after.filter((p) => !shown.has(p.id))
    const page = result.data.pages.at(-1)
    if (added.length === 0 || !page) return announce(postingsCopy.announce.nothingNew)
    pendingFocus.current = added[0].id
    announce(
      loadedAnnouncement({ added: added.length, loaded: after.length, total: page.totalCount, hasMore: page.nextCursor !== null })
    )
  }

  /** A cursor the server refused (400) won't work again: reload this view from page 1. */
  async function restart() {
    setIsRestarting(true)
    try {
      queryClient.setQueryData(options.queryKey, (data) =>
        data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
      )
      const result = await list.refetch()
      const page = result.data?.pages.at(-1)
      const first = result.data?.pages[0]?.postings[0]
      if (result.isError || !result.data || !page || !first) return announce(postingsCopy.announce.loadFailed)
      pendingFocus.current = first.id
      const line = formatCountLine({
        total: page.totalCount,
        loaded: loadedPostings(result.data.pages).length,
        hasMore: page.nextCursor !== null,
        filtered: isFiltered,
      })
      announce(formatCopy(postingsCopy.announce.restarted, { countLine: line }))
    } finally {
      setIsRestarting(false)
    }
  }

  function clearFilters() {
    setFilter(NO_FILTER)
    searchRef.current?.focus()
  }

  return {
    tab,
    /** The tab the URL names: Good matches, Not a match or All. */
    webTab,
    filter,
    /** The Posting filter panel's families: the Candidate's targets once the first page answers, else none. */
    targetRoleFamilies: pages[0]?.targetRoleFamilies ?? [],
    setTab,
    setFilter,
    clearFilters,
    rows,
    page: latest ?? null,
    isFiltered,
    isPlaceholder,
    isFetching: list.isFetching,
    /** The first page failed; a failed Load more keeps the rows instead. */
    isError: list.isError && !list.data,
    retry: () => void list.refetch(),
    countLine,
    /** The empty state to show, or "list" / null (skeleton) when rows or nothing settled yet decide instead. */
    content: rows.length > 0 ? ("list" as const) : shown === "list" ? null : (shown ?? null),
    /** The shown content belongs to the last settled view; the new one is still loading. */
    isStale: current === undefined,
    loadMore: {
      isShown: hasMore,
      isBusy: isLoadMoreBusy,
      isLoading: isLoadingMore,
      hasError: loadMoreError,
      onPress: () => void loadMore(),
    },
    status: message,
    announce,
  }
}

/** What the tab section shows once a view has settled: the list or one of the B2 empty states. */
/** v1.23.0 (B1): Not a match's keyword and excluded-family sections have their own empty states (F18a steps 6, 8). */
export type PostingsContent = "list" | "filterEmpty" | "allHidden" | "criteriaEmpty" | "firstRun" | "rankedEmpty" | "skippedEmpty" | "manualEmpty" | "excludedEmpty"

/**
 * EPIC-0006 design-spec.r1 B4 precedence for a settled page (the load error is handled
 * before this): filter-empty, rows, all hidden (no visible posting on any tab while some
 * are hidden), criteria empty state (Ranked), then the built empty state. Undefined while
 * unsettled.
 */
export function settledContent(view: {
  latest: JobPostingPage | undefined
  rows: number
  isPlaceholder: boolean
  isFiltered: boolean
  tab: PostingsTab
  anyPending: boolean
  anyExists: boolean | undefined
}): PostingsContent | undefined {
  const { latest, rows, isPlaceholder, isFiltered, tab } = view
  if (!latest || isPlaceholder) return undefined
  if (isFiltered && latest.totalCount === 0) return "filterEmpty"
  if (rows > 0) return "list"
  const anyHidden = latest.hiddenCounts.total > 0
  // Unfiltered All with no rows: no visible posting exists anywhere.
  if (tab === "all") return anyHidden ? "allHidden" : "firstRun"
  if (anyHidden) {
    if (view.anyPending) return undefined
    if (view.anyExists === false) return "allHidden"
  }
  if (tab === "ranked" && !isFiltered && latest.criteriaEmptyState) return "criteriaEmpty"
  if (view.anyPending) return undefined
  // First run (nothing on any tab) shows the first-run state on every tab, as built (F18a step 8).
  if (view.anyExists === false) return "firstRun"
  return tab === "ranked" ? "rankedEmpty" : tab === "skipped" ? "skippedEmpty" : tab === "manual" ? "manualEmpty" : "excludedEmpty"
}
