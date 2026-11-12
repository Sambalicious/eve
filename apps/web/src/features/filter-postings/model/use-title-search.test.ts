import type { ChangeEvent, KeyboardEvent } from "react"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TITLE_SEARCH_DEBOUNCE_MS, useTitleSearch } from "./use-title-search"

const change = (value: string) => ({ target: { value } }) as ChangeEvent<HTMLInputElement>
const key = (name: string) => ({ key: name, preventDefault: vi.fn() }) as unknown as KeyboardEvent<HTMLInputElement>

function setup(keyword: string | null = null) {
  const onCommit = vi.fn()
  // With no family in play, the filter is active exactly when a keyword is set.
  const hook = renderHook(
    (props: { keyword: string | null }) =>
      useTitleSearch({ keyword: props.keyword, isFilterActive: props.keyword !== null, onCommit }),
    { initialProps: { keyword } }
  )
  return { ...hook, onCommit }
}

/** Types `text` one character every `gap` ms; the clock stops right after the last character. */
function typeSlowly(result: { current: ReturnType<typeof useTitleSearch> }, text: string, gap: number) {
  for (let i = 1; i <= text.length; i += 1) {
    if (i > 1) act(() => vi.advanceTimersByTime(gap))
    act(() => result.current.onChange(change(text.slice(0, i))))
  }
}

describe("useTitleSearch (8W.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("debounces 300 ms", () => {
    expect(TITLE_SEARCH_DEBOUNCE_MS).toBe(300)
  })

  it("WEB-05 commits once, with the whole word, only after typing stops", () => {
    const { result, onCommit } = setup()
    typeSlowly(result, "react", 100)
    expect(onCommit).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(300))
    expect(onCommit.mock.calls).toEqual([["react"]])
  })

  it.each([
    [299, []],
    [300, [["react"]]],
  ])("WEB-06 after %i ms of quiet the commits are %j", (wait, calls) => {
    const { result, onCommit } = setup()
    typeSlowly(result, "react", 100)
    act(() => vi.advanceTimersByTime(wait))
    expect(onCommit.mock.calls).toEqual(calls)
  })

  it("WEB-08 Enter commits at once and prevents the form default", () => {
    const { result, onCommit } = setup()
    act(() => result.current.onChange(change("react")))
    const enter = key("Enter")
    act(() => result.current.onKeyDown(enter))
    expect(enter.preventDefault).toHaveBeenCalled()
    expect(onCommit.mock.calls).toEqual([["react"]])
    act(() => vi.advanceTimersByTime(300))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("WEB-09 Escape clears a field with text; an empty field leaves Escape alone", () => {
    const { result, onCommit } = setup("react")
    const escape = key("Escape")
    act(() => result.current.onKeyDown(escape))
    expect(result.current.text).toBe("")
    expect(onCommit.mock.calls).toEqual([[null]])

    const again = key("Escape")
    act(() => result.current.onKeyDown(again))
    expect(again.preventDefault).not.toHaveBeenCalled()
  })

  it("WEB-10b commits the trimmed text and null for spaces, but shows what was typed", () => {
    const { result, onCommit } = setup()
    act(() => result.current.onChange(change("  react  ")))
    act(() => vi.advanceTimersByTime(300))
    expect(onCommit.mock.calls).toEqual([["react"]])
    expect(result.current.text).toBe("  react  ")
  })

  it("8d.15 typing only invisible characters commits nothing and keeps what was typed", () => {
    const { result, onCommit } = setup()
    act(() => result.current.onChange(change("\u200B")))
    act(() => vi.advanceTimersByTime(300))
    act(() => result.current.onKeyDown(key("Enter")))
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.text).toBe("\u200B")
  })

  it("8d.15 replacing a keyword with only invisible characters removes the keyword", () => {
    const { result, onCommit } = setup("react")
    act(() => result.current.onChange(change("\u00AD\u2060")))
    act(() => vi.advanceTimersByTime(300))
    expect(onCommit.mock.calls).toEqual([[null]])
    expect(result.current.text).toBe("\u00AD\u2060")
  })

  it.each([
    ["cleared (Clear filters)", "react", null],
    ["changed (Back or a link)", "react", "vue"],
  ] as const)(
    "F-QA8-02 a pending keystroke is dropped when the keyword is %s from outside within 300 ms",
    (_case, start, outside) => {
      const { result, rerender, onCommit } = setup(start)
      act(() => result.current.onChange(change("engineer")))
      rerender({ keyword: outside })
      act(() => vi.advanceTimersByTime(1000))
      expect(onCommit).not.toHaveBeenCalled()
      expect(result.current.text).toBe(outside ?? "")
    }
  )

  it("F-QA8-02 an outside change that equals the typed text keeps the field and commits nothing more", () => {
    const { result, rerender, onCommit } = setup(null)
    act(() => result.current.onChange(change("react")))
    rerender({ keyword: "react" })
    act(() => vi.advanceTimersByTime(1000))
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.text).toBe("react")
  })

  it("a rerender with the same keyword keeps the pending keystroke", () => {
    const { result, rerender, onCommit } = setup(null)
    act(() => result.current.onChange(change("react")))
    rerender({ keyword: null })
    act(() => vi.advanceTimersByTime(300))
    expect(onCommit.mock.calls).toEqual([["react"]])
  })

  it("F-QA8-02 reset() empties the field and drops the pending commit without committing", () => {
    const { result, onCommit } = setup(null)
    act(() => result.current.onChange(change("engineer")))
    act(() => result.current.reset())
    act(() => vi.advanceTimersByTime(1000))
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.text).toBe("")
  })

  it("its own commit is not an outside change: typing on after a commit still commits", () => {
    const { result, rerender, onCommit } = setup(null)
    act(() => result.current.onChange(change("rea")))
    act(() => vi.advanceTimersByTime(300))
    act(() => result.current.onChange(change("react")))
    rerender({ keyword: "rea" })
    act(() => vi.advanceTimersByTime(300))
    expect(onCommit.mock.calls).toEqual([["rea"], ["react"]])
    expect(result.current.text).toBe("react")
  })

  it("WEB-10b committing a blank search that empties the filter keeps what was typed", () => {
    const { result, rerender } = setup("go")
    act(() => result.current.onChange(change("   ")))
    act(() => vi.advanceTimersByTime(300))
    rerender({ keyword: null })
    expect(result.current.text).toBe("   ")
  })

  it("rewrites the field when the keyword changes from outside", () => {
    const { result, rerender } = setup("react")
    rerender({ keyword: null })
    expect(result.current.text).toBe("")
  })
})
