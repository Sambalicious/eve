import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { FEED_ROW_EXIT_MS, useFeedRowPresence } from "./use-feed-row-presence"

type Row = { id: string }
const a: Row = { id: "a" }
const b: Row = { id: "b" }
const c: Row = { id: "c" }

const view = (rows: ReturnType<typeof useFeedRowPresence<Row>>) => rows.map(({ item, phase }) => `${item.id}:${phase}`)

function setup(initial: Row[], reducedMotion = false) {
  return renderHook(({ items, reduce }) => useFeedRowPresence(items, reduce), { initialProps: { items: initial, reduce: reducedMotion } })
}

describe("useFeedRowPresence (design-spec r1 Motion, N-1)", () => {
  it("rows present at mount do not animate", () => {
    const { result } = setup([a, b])
    expect(view(result.current)).toEqual(["a:present", "b:present"])
  })

  it("a row added later enters (fade in); the others stay present", () => {
    const { result, rerender } = setup([a])
    rerender({ items: [a, b], reduce: false })
    expect(view(result.current)).toEqual(["a:present", "b:entering"])
  })

  it(`a removed row stays at its place while leaving, then goes after ${FEED_ROW_EXIT_MS}ms`, () => {
    vi.useFakeTimers()
    const { result, rerender } = setup([a, b, c])
    rerender({ items: [a, c], reduce: false })
    expect(view(result.current)).toEqual(["a:present", "b:leaving", "c:present"])
    act(() => vi.advanceTimersByTime(FEED_ROW_EXIT_MS - 1))
    expect(view(result.current)).toEqual(["a:present", "b:leaving", "c:present"])
    act(() => vi.advanceTimersByTime(1))
    expect(view(result.current)).toEqual(["a:present", "c:present"])
  })

  it("removing the last row keeps it leaving, then the list is empty", () => {
    vi.useFakeTimers()
    const { result, rerender } = setup([a])
    rerender({ items: [], reduce: false })
    expect(view(result.current)).toEqual(["a:leaving"])
    act(() => vi.advanceTimersByTime(FEED_ROW_EXIT_MS))
    expect(view(result.current)).toEqual([])
  })

  it("a row that comes back while leaving is present again and is not dropped by the old timer", () => {
    vi.useFakeTimers()
    const { result, rerender } = setup([a, b])
    rerender({ items: [a], reduce: false })
    rerender({ items: [a, b], reduce: false })
    act(() => vi.advanceTimersByTime(FEED_ROW_EXIT_MS))
    expect(view(result.current).map((s) => s.split(":")[0])).toEqual(["a", "b"])
    expect(view(result.current)).not.toContain("b:leaving")
  })

  it("under reduced motion, an added row is present at once and a removed row goes at once", () => {
    const { result, rerender } = setup([a, b], true)
    rerender({ items: [a, b, c], reduce: true })
    expect(view(result.current)).toEqual(["a:present", "b:present", "c:present"])
    rerender({ items: [a, c], reduce: true })
    expect(view(result.current)).toEqual(["a:present", "c:present"])
  })

  it("the final list is the same with either preference", () => {
    vi.useFakeTimers()
    const motion = setup([a, b])
    const still = setup([a, b], true)
    motion.rerender({ items: [b, c], reduce: false })
    still.rerender({ items: [b, c], reduce: true })
    act(() => vi.advanceTimersByTime(FEED_ROW_EXIT_MS))
    expect(motion.result.current.map((r) => r.item.id)).toEqual(still.result.current.map((r) => r.item.id))
  })
})
