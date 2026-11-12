import { useEffect, type RefObject } from "react"

/**
 * Marks a horizontally scrolling element with `data-overflow-end` while content remains
 * past its end edge, so CSS can fade that edge (EPIC-0002 DP-B1-07). Updates on scroll and
 * resize; the attribute is absent when everything fits or the end is reached.
 */
export function useOverflowEnd(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const remaining = element.scrollWidth - element.clientWidth - Math.abs(element.scrollLeft)
      if (remaining > 1) element.dataset.overflowEnd = ""
      else delete element.dataset.overflowEnd
    }
    update()
    element.addEventListener("scroll", update, { passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    observer?.observe(element)
    return () => {
      element.removeEventListener("scroll", update)
      observer?.disconnect()
    }
  }, [ref])
}
