import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { usePagination } from "./use-pagination"

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

describe("usePagination (F9: 25 rows per page)", () => {
  it("101 items make 5 pages of at most 25; the last has 1", () => {
    const { result } = renderHook(() => usePagination(range(101)))
    expect(result.current.pageCount).toBe(5)
    expect(result.current.pageItems).toHaveLength(25)
    act(() => result.current.goTo(9))
    expect(result.current.page).toBe(5)
    expect(result.current.pageItems).toEqual([100])
  })

  it("clamps back a page when the last page empties", () => {
    const { result, rerender } = renderHook(({ items }) => usePagination(items), { initialProps: { items: range(30) } })
    act(() => result.current.goTo(2))
    rerender({ items: range(25) })
    expect(result.current.page).toBe(1)
    expect(result.current.pageItems).toHaveLength(25)
  })
})
