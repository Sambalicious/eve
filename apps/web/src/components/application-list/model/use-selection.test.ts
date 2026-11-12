import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useSelection } from "./use-selection"

describe("useSelection (bulk toolbar)", () => {
  it("selects all on the page, then drops IDs that left the page", () => {
    const { result, rerender } = renderHook(({ ids }) => useSelection(ids), { initialProps: { ids: ["a", "b", "c"] } })
    act(() => result.current.toggleAll(true))
    expect(result.current.selected).toEqual(["a", "b", "c"])
    expect(result.current.allSelected).toBe(true)
    rerender({ ids: ["b"] })
    expect(result.current.selected).toEqual(["b"])
  })

  it("one row toggled is 'some', not 'all'", () => {
    const { result } = renderHook(() => useSelection(["a", "b"]))
    act(() => result.current.toggle("b", true))
    expect(result.current.someSelected).toBe(true)
    act(() => result.current.toggle("b", false))
    expect(result.current.selected).toEqual([])
  })
})
