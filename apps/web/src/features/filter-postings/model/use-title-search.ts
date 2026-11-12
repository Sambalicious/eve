import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react"

import { toKeyword } from "./postings-url"

/** Quiet time after the last keystroke before the keyword applies (8W.2). */
export const TITLE_SEARCH_DEBOUNCE_MS = 300

/**
 * The title search field. It shows what the Candidate typed; the committed
 * keyword is trimmed, and null when blank or when it folds to empty (only
 * invisible characters, 8d.15), so typing those changes nothing. Typing commits after 300 ms of quiet,
 * Enter commits at once, Escape (when non-empty) and the clear button empty the
 * field and commit at once.
 *
 * Outside changes win over a pending keystroke (F-QA8-02). The pending commit
 * is dropped and the field shows the keyword in force when:
 * - the keyword changes and this hook didn't commit it (Back, Forward, a link);
 * - the filter goes from active to empty (either "Clear filters", "See them"),
 *   even though the keyword may already have been empty.
 * `reset()` does the same at once, for the "Clear filters" button beside the field.
 * A tab change keeps the filter (8W.4), so a pending keystroke still applies.
 */
export function useTitleSearch({
  keyword,
  isFilterActive,
  onCommit,
}: {
  keyword: string | null
  /** Whether a family or a keyword is set in the URL. */
  isFilterActive: boolean
  onCommit: (keyword: string | null) => void
}) {
  const [text, setText] = useState(keyword ?? "")
  const [shown, setShown] = useState({ keyword, isFilterActive })
  // What this hook last committed, so its own commit isn't taken for an outside change.
  const [ownKeyword, setOwnKeyword] = useState(keyword)
  // Bumped by each outside change; a timer started in an older generation does nothing.
  const [generation, setGeneration] = useState(0)
  const generationRef = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(onCommit)
  const keywordRef = useRef(keyword)

  useEffect(() => {
    commitRef.current = onCommit
    keywordRef.current = keyword
  })
  // A layout effect runs in the same task as the render that saw the change, so no timer fires first.
  useLayoutEffect(() => {
    if (generation === generationRef.current) return
    generationRef.current = generation
    cancel()
  }, [generation])
  useEffect(() => () => cancel(), [])

  if (keyword !== shown.keyword || isFilterActive !== shown.isFilterActive) {
    setShown({ keyword, isFilterActive })
    const isOwnCommit = keyword !== shown.keyword && keyword === ownKeyword
    const isOutsideKeyword = keyword !== shown.keyword && !isOwnCommit
    // Emptied by something else: not by this hook committing a blank search (WEB-10b).
    const isCleared = shown.isFilterActive && !isFilterActive && !isOwnCommit
    if (isOutsideKeyword || isCleared) {
      setOwnKeyword(keyword)
      setGeneration((value) => value + 1)
      // Design F4-8b step 5: the field shows the keyword in force.
      setText(keyword ?? "")
    }
  }

  function cancel() {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  function commit(value: string) {
    cancel()
    const next = toKeyword(value)
    if (next === keywordRef.current) return
    keywordRef.current = next
    setOwnKeyword(next)
    commitRef.current(next)
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value
    setText(value)
    cancel()
    const startedIn = generationRef.current
    timer.current = setTimeout(() => {
      if (startedIn === generationRef.current) commit(value)
    }, TITLE_SEARCH_DEBOUNCE_MS)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      commit(text)
    } else if (event.key === "Escape" && text !== "") {
      event.preventDefault()
      clear()
    }
  }

  function clear() {
    setText("")
    commit("")
  }

  /** Empties the field and drops a pending commit without committing; the caller clears the filter. */
  function reset() {
    cancel()
    generationRef.current += 1
    setGeneration(generationRef.current)
    setText("")
  }

  return { text, onChange, onKeyDown, clear, reset }
}
