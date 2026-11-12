import { useEffect } from "react"
import { useLocation } from "react-router-dom"

/**
 * With a hash such as `#job-criteria`, scroll to that section once it has
 * rendered. When the section's heading opts in to focus (`tabIndex={-1}`, as
 * Job criteria and Contact details do), focus moves to it without a second
 * scroll, so keyboard and screen reader users are told where they landed
 * (EPIC-0004 design-spec J5 step 5). Runs once per hash after `isReady`.
 */
export function useScrollToHash(isReady: boolean) {
  const { hash } = useLocation()
  useEffect(() => {
    if (!isReady || !hash) return
    const target = document.getElementById(decodeURIComponent(hash.slice(1)))
    if (!target) return
    target.scrollIntoView?.({ block: "start" })
    focusableHeading(target)?.focus({ preventScroll: true })
  }, [hash, isReady])
}

/** The heading that names the section (`aria-labelledby`), if it was made focusable with `tabIndex={-1}`. */
function focusableHeading(section: HTMLElement): HTMLElement | null {
  const headingId = section.getAttribute("aria-labelledby")
  const heading = headingId ? document.getElementById(headingId) : null
  return heading?.getAttribute("tabindex") === "-1" ? heading : null
}
