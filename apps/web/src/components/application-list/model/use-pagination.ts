import { useState } from "react"

/** F9 step 1: 25 rows per page. */
export const PAGE_SIZE = 25

/**
 * Client-side pages over an already-loaded list. The page number is clamped,
 * so deleting the last rows of the last page moves back one page.
 */
export function usePagination<T>(items: readonly T[], pageSize = PAGE_SIZE) {
  const [requested, setRequested] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const page = Math.min(requested, pageCount)
  return {
    page,
    pageCount,
    pageItems: items.slice((page - 1) * pageSize, page * pageSize),
    goTo: (next: number) => setRequested(Math.min(Math.max(1, next), pageCount)),
  }
}
