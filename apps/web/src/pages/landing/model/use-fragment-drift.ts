import { useEffect, type RefObject } from "react"

import { DRIFT_LIMIT_MS, DRIFT_SETTLE_MS } from "./hero-fragments"

const REDUCE = "(prefers-reduced-motion: reduce)"
const FINE_HOVER = "(hover: hover) and (pointer: fine)"

interface DriftRefs {
  heroRef: RefObject<HTMLElement | null>
  frameRef: RefObject<HTMLElement | null>
  demoRef: RefObject<HTMLElement | null>
}

/**
 * Idle drift and scroll parallax for the hero fragments (design-spec r3
 * I-HERO, Accessibility > Motion). Drift is CSS keyframes gated by
 * `data-drift` on the hero; this hook only flips attributes:
 * - drift starts when the frame's run ends (`data-motion="end"` after playing);
 * - it pauses off-screen, while the tab is hidden and on fine-pointer hover
 *   over the frame wrapper (`data-drift-paused`), and the layer hint goes with
 *   it (`data-hero-visible`);
 * - after 60 s of drift in view it eases to rest over 600 ms and stops; the
 *   next time the hero re-enters the viewport it runs another 60 s.
 * Parallax uses `animation-timeline: scroll()` where supported; otherwise one
 * rAF-throttled passive scroll listener writes `--hero-scroll` on the hero
 * only, and only while the hero intersects the viewport.
 */
export function useFragmentDrift({ heroRef, frameRef, demoRef }: DriftRefs) {
  useEffect(() => {
    const heroEl = heroRef.current
    const frame = frameRef.current
    const demo = demoRef.current
    if (!heroEl || !frame || !demo || typeof IntersectionObserver === "undefined") return
    const hero: HTMLElement = heroEl
    const reduce = window.matchMedia(REDUCE)
    const fineHover = window.matchMedia(FINE_HOVER)
    const nativeParallax = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll()")

    let visible = false
    let hovered = false
    let ended = false
    let budget = DRIFT_LIMIT_MS
    let since = 0
    let stopTimer = 0
    let settle: Animation[] = []

    const drifting = () => hero.dataset.drift === "on"
    const running = () => drifting() && visible && !hovered && document.visibilityState === "visible" && !reduce.matches

    const sync = () => {
      hero.toggleAttribute("data-hero-visible", visible)
      hero.toggleAttribute("data-drift-paused", drifting() && !running())
      window.clearTimeout(stopTimer)
      if (running()) {
        since = performance.now()
        stopTimer = window.setTimeout(stop, budget)
      }
    }
    const spend = () => {
      if (running()) budget = Math.max(0, budget - (performance.now() - since))
    }

    const start = () => {
      if (reduce.matches || !document.documentElement.classList.contains("motion-ok")) return
      settle.forEach((a) => a.cancel())
      settle = []
      budget = DRIFT_LIMIT_MS
      hero.dataset.drift = "on"
      sync()
    }

    function stop() {
      spend()
      // Ease from wherever each layer is to rest, then leave it there.
      const layers = [...hero.querySelectorAll<HTMLElement>(".hero-frag-drift")]
      const from = layers.map((el) => getComputedStyle(el).transform)
      hero.dataset.drift = "off"
      settle = typeof Element.prototype.animate === "function"
        ? layers.map((el, i) => el.animate([{ transform: from[i] === "none" ? "none" : from[i] }, { transform: "none" }], { duration: DRIFT_SETTLE_MS, easing: "ease-out" }))
        : []
      sync()
    }

    // The frame's run ending starts the drift.
    const motionObserver = new MutationObserver(() => {
      const motion = frame.dataset.motion
      if (motion === "playing" || motion === "rewinding") {
        ended = false
        if (drifting()) {
          spend()
          hero.dataset.drift = "off"
          sync()
        }
      } else if (motion === "end" && !ended) {
        ended = true
        start()
      }
    })
    motionObserver.observe(frame, { attributes: true, attributeFilter: ["data-motion"] })

    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const scrolled = Math.max(0, -hero.getBoundingClientRect().top)
        hero.style.setProperty("--hero-scroll", String(Math.round(scrolled)))
      })
    }
    const listen = (on: boolean) => {
      if (nativeParallax || reduce.matches) return
      if (on) window.addEventListener("scroll", onScroll, { passive: true })
      else window.removeEventListener("scroll", onScroll)
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        const was = visible
        spend()
        visible = entry.isIntersecting
        listen(visible)
        // Coming back into view after drift stopped runs it for another 60 s.
        if (visible && !was && ended && hero.dataset.drift === "off") start()
        else sync()
      },
      { threshold: 0 }
    )
    observer.observe(hero)

    const onVisibility = () => {
      spend()
      sync()
    }
    const onEnter = () => {
      if (!fineHover.matches) return
      spend()
      hovered = true
      sync()
    }
    const onLeave = () => {
      hovered = false
      sync()
    }
    const onReduce = () => {
      spend()
      if (reduce.matches) listen(false)
      else listen(visible)
      sync()
    }
    document.addEventListener("visibilitychange", onVisibility)
    demo.addEventListener("pointerenter", onEnter)
    demo.addEventListener("pointerleave", onLeave)
    demo.addEventListener("focusin", onEnter)
    demo.addEventListener("focusout", onLeave)
    reduce.addEventListener("change", onReduce)

    return () => {
      motionObserver.disconnect()
      observer.disconnect()
      listen(false)
      cancelAnimationFrame(raf)
      window.clearTimeout(stopTimer)
      settle.forEach((a) => a.cancel())
      document.removeEventListener("visibilitychange", onVisibility)
      demo.removeEventListener("pointerenter", onEnter)
      demo.removeEventListener("pointerleave", onLeave)
      demo.removeEventListener("focusin", onEnter)
      demo.removeEventListener("focusout", onLeave)
      reduce.removeEventListener("change", onReduce)
      delete hero.dataset.drift
      hero.removeAttribute("data-drift-paused")
      hero.removeAttribute("data-hero-visible")
      hero.style.removeProperty("--hero-scroll")
    }
  }, [heroRef, frameRef, demoRef])
}
