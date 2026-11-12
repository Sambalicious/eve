import { useCallback, useEffect, useRef, useState } from "react"

/** How long "View it" highlights the stored row (F1 failure paths, C-EXIST-3). */
export const HIGHLIGHT_MS = 2000

/**
 * "View it": scrolls the record's row (or card below 640px) into view, moves
 * focus to it so keyboard and screen reader users land there too, and
 * highlights it for 2 s. `attribute` names the data attribute holding the id.
 */
export function useRowHighlight(attribute: string) {
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  /** Highlights the row and returns it, so a closing overlay can hand focus to it. */
  const highlight = useCallback(
    (id: string): HTMLElement | null => {
      const matches = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[${attribute}="${CSS.escape(id)}"]`
        )
      )
      // The table and the card list both render; CSS hides one of them.
      const target =
        matches.find((el) => el.getClientRects().length > 0) ??
        matches[0] ??
        null
      target?.scrollIntoView?.({ block: "center" })
      target?.focus({ preventScroll: true })
      setHighlightedId(id)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setHighlightedId(null), HIGHLIGHT_MS)
      return target
    },
    [attribute]
  )
  return { highlightedId, highlight }
}
