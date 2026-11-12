import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import { createPlayer, resolveTimeline, type PlannedAnimation, type Player } from "@/shared/lib/motion"
import { planFragmentEntrances } from "./hero-fragments"
import { heroCounts, HERO_SCENES } from "./hero-scenes"
import { motionAllowed } from "./reveal"

const REDUCE = "(prefers-reduced-motion: reduce)"
const FINE_HOVER = "(hover: hover) and (pointer: fine)"
const WIDE = "(min-width: 768px)"
const FONT_WAIT_MS = 300
const THRESHOLDS = [0, 0.2, 0.25, 0.5, 0.75, 1]
/** F-QA-E3C-01 ruling: start at 20% visible, or after 600 ms in view at any ratio. */
const START_RATIO = 0.2
const DWELL_MS = 600
// Browsers may report a crossing just under the threshold.
const RATIO_SLACK = 0.001

interface HeroRefs {
  frameRef: RefObject<HTMLDivElement | null>
  demoRef: RefObject<HTMLDivElement | null>
}

/**
 * Wires the hero frame (design-spec r1 4.4 to 4.6, architecture r1 section 4).
 * Starts once motion is allowed, the tab is visible, two frames have painted,
 * fonts are ready (or 300 ms passed) and the frame is 20% visible or has
 * been in view for 600 ms (F-QA-E3C-01 ruling). Pause
 * reasons: hover on fine pointers, window blur, hidden tab, off-screen.
 * Reduced motion turned on finishes the run and hides Replay.
 */
export function useHeroPlayer({ frameRef, demoRef }: HeroRefs) {
  // Prerendered markup has Replay hidden (no `document`); the client shows it when motion is allowed.
  const [replayHidden, setReplayHidden] = useState(() => typeof document === "undefined" || !motionAllowed() || !canAnimate())
  const playerRef = useRef<Player | null>(null)

  useEffect(() => {
    const frame = frameRef.current
    const demo = demoRef.current
    if (!frame || !demo) return
    const html = document.documentElement
    const reduce = window.matchMedia(REDUCE)
    const wide = window.matchMedia(WIDE)

    const onReduce = () => {
      if (reduce.matches) {
        html.classList.remove("motion-ok")
        playerRef.current?.finish()
        frame.dataset.motion = "end"
        setReplayHidden(true)
      } else if (canAnimate()) {
        html.classList.add("motion-ok")
        setReplayHidden(false)
      }
    }
    reduce.addEventListener("change", onReduce)

    if (!canAnimate()) {
      frame.dataset.motion = "end"
      return () => reduce.removeEventListener("change", onReduce)
    }
    // Under reduced motion the player exists but never starts on its own;
    // turning reduced motion off shows Replay, which then plays (AC 5.5).
    const autoStart = motionAllowed()
    if (!autoStart) frame.dataset.motion = "end"

    const plan = (): PlannedAnimation[] => {
      const groups = new Map<string, Element[]>()
      for (const element of frame.querySelectorAll<HTMLElement>("[data-a]")) {
        if (element.closest("[data-wide]") && !wide.matches) continue
        const name = element.dataset.a!
        groups.set(name, [...(groups.get(name) ?? []), element])
      }
      const scenes = resolveTimeline(HERO_SCENES, heroCounts(wide.matches)).flatMap((a) => {
        const element = groups.get(a.target)?.[a.index]
        return element
          ? [{ element, keyframes: a.keyframes, options: { delay: a.delay, duration: a.duration, easing: a.easing, fill: a.fill, composite: "replace" as const } }]
          : []
      })
      // design-spec r3 I-HERO: fragments enter as their scene ends, with the frame (Replay re-runs them).
      return [...scenes, ...planFragmentEntrances(demo.querySelectorAll<HTMLElement>(".hero-frag-card"))]
    }
    const paused = demo.querySelector<HTMLElement>(".hf-paused")
    const player = createPlayer({
      root: frame,
      plan,
      onChange: ({ hoverOnly }) => paused?.toggleAttribute("data-show", hoverOnly),
    })
    playerRef.current = player

    let started = !autoStart
    let inView = false
    let dwellTimer: number | undefined
    let painted = false
    let fontsReady = false
    const tryStart = () => {
      if (started || !inView || !painted || !fontsReady || document.visibilityState !== "visible") return
      started = true
      player.play()
    }

    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        painted = true
        tryStart()
      })
    })
    const fontTimer = window.setTimeout(() => {
      fontsReady = true
      tryStart()
    }, FONT_WAIT_MS)
    void document.fonts?.ready.then(() => {
      fontsReady = true
      tryStart()
    })

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        const rootHeight = entry.rootBounds?.height ?? window.innerHeight
        inView = entry.intersectionRatio >= START_RATIO - RATIO_SLACK || entry.intersectionRect.height >= 0.5 * rootHeight
        if (entry.isIntersecting) {
          player.resume("offscreen")
          dwellTimer ??= window.setTimeout(() => {
            dwellTimer = undefined
            inView = true
            tryStart()
          }, DWELL_MS)
        } else {
          player.pause("offscreen")
          window.clearTimeout(dwellTimer)
          dwellTimer = undefined
        }
        tryStart()
      },
      { threshold: THRESHOLDS }
    )
    observer.observe(frame)

    const onVisibility = () => {
      if (document.visibilityState === "hidden") player.pause("hidden")
      else {
        player.resume("hidden")
        tryStart()
      }
    }
    const onBlur = () => player.pause("blur")
    const onFocus = () => player.resume("blur")
    const fineHover = window.matchMedia(FINE_HOVER)
    const onEnter = () => fineHover.matches && player.pause("hover")
    const onLeave = () => player.resume("hover")
    const onWide = () => player.finish()

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    frame.addEventListener("pointerenter", onEnter)
    frame.addEventListener("pointerleave", onLeave)
    wide.addEventListener("change", onWide)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(fontTimer)
      window.clearTimeout(dwellTimer)
      observer.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
      frame.removeEventListener("pointerenter", onEnter)
      frame.removeEventListener("pointerleave", onLeave)
      wide.removeEventListener("change", onWide)
      reduce.removeEventListener("change", onReduce)
      player.destroy()
      playerRef.current = null
    }
  }, [frameRef, demoRef])

  const replay = useCallback(() => playerRef.current?.replay(), [])
  return { replayHidden, replay }
}

function canAnimate(): boolean {
  return typeof IntersectionObserver !== "undefined" && typeof Element.prototype.animate === "function"
}
