import { useCallback, useEffect, useMemo } from "react"
import { useLocation, useNavigate } from "react-router-dom"

import type { PostingFilter } from "@/entities/job-posting"
import { postingsSearch, readPostingsView, type PostingsWebTab } from "./postings-url"

/**
 * The Job Postings view held in the URL (design addendum, URL behaviour). A
 * tab change pushes a history entry and keeps the filter; a filter change
 * replaces the entry. Invalid values are dropped by rewriting the URL in place.
 * Nothing is stored anywhere else (8W.5).
 */
export function usePostingsUrl() {
  const { search } = useLocation()
  const navigate = useNavigate()
  const current = search.replace(/^\?/, "")
  const view = useMemo(() => readPostingsView(new URLSearchParams(current)), [current])
  const canonical = postingsSearch({ tab: view.hasTab ? view.tab : null, filter: view.filter })

  const go = useCallback(
    (next: string, replace: boolean, hash = "") => navigate({ search: next === "" ? "" : `?${next}`, hash }, { replace }),
    [navigate]
  )

  useEffect(() => {
    if (canonical !== current) go(canonical, true, view.legacyExcluded ? "#excluded-families" : "")
  }, [canonical, current, go, view.legacyExcluded])

  const setTab = useCallback((tab: PostingsWebTab) => go(postingsSearch({ tab, filter: view.filter }), false), [go, view.filter])
  const setFilter = useCallback(
    (filter: PostingFilter) => go(postingsSearch({ tab: view.hasTab ? view.tab : null, filter }), true),
    [go, view.hasTab, view.tab]
  )

  return { tab: view.tab, filter: view.filter, setTab, setFilter }
}
