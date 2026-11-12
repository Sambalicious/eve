import { useLayoutEffect, type RefObject } from "react"

import { motionAllowed, revealNow, revealThrough } from "./reveal"

const OBSERVER: IntersectionObserverInit = { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }

/**
 * Scroll reveals for sections 3 to 6 (design-spec r1 5, architecture r1
 * deviation). The hidden start state applies only under
 * `html.motion-ok.motion-ready`, added here after mount, so slow or failed
 * JavaScript never leaves a section at opacity 0. Sections already in view,
 * and everything through a hash target, are marked revealed first.
 */
export function useSectionReveal(rootRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !motionAllowed() || typeof IntersectionObserver === "undefined") return
    const html = document.documentElement

    const sections = [...root.querySelectorAll<HTMLElement>("[data-reveal]")]
    const hashTarget = window.location.hash ? root.querySelector(window.location.hash.replace(/[^#\w-]/g, "")) : null
    if (hashTarget) revealThrough(root, hashTarget)
    const fold = window.innerHeight * 0.92
    for (const section of sections) {
      if (section.getBoundingClientRect().top < fold) revealNow(section)
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.setAttribute("data-revealed", "")
        observer.unobserve(entry.target)
      }
    }, OBSERVER)
    for (const section of sections) {
      if (!section.hasAttribute("data-revealed")) observer.observe(section)
    }
    html.classList.add("motion-ready")

    return () => {
      observer.disconnect()
      html.classList.remove("motion-ready")
    }
  }, [rootRef])
}
