import { EASE_EMPHASIZED, DURATION, type PlannedAnimation } from "@/shared/lib/motion"

/**
 * Hero fragment entrances (design-spec r3 I-HERO Motion): each fragment
 * appears once as the frame's matching scene ends. Times are from the frame
 * timeline (unchanged 3,260 ms).
 */
export const FRAGMENT_ENTRANCE_MS: Record<1 | 2 | 3 | 4, number> = {
  1: 900,
  2: 1380,
  3: 2800,
  4: 3260,
}

/** Drift runs at most this long per stay in view (WCAG 2.2.2), then eases to rest. */
export const DRIFT_LIMIT_MS = 60_000
export const DRIFT_SETTLE_MS = 600

/**
 * Parallax depth per fragment (px moved per px scrolled), over the first
 * 200 px of scroll, so F4 reaches the 24 px cap and the others less. The CSS
 * (`--depth` on each fragment) uses the same numbers.
 */
export const PARALLAX_DEPTH: Record<1 | 2 | 3 | 4, number> = { 1: -0.06, 2: -0.1, 3: -0.04, 4: -0.12 }
export const PARALLAX_MAX_PX = 24
export const PARALLAX_RANGE_PX = 200

/** The parallax offset for one fragment at `scrolled` px past the hero's top. */
export function parallaxOffset(n: 1 | 2 | 3 | 4, scrolled: number): number {
  const px = PARALLAX_DEPTH[n] * Math.min(Math.max(scrolled, 0), PARALLAX_RANGE_PX)
  return Math.max(-PARALLAX_MAX_PX, Math.min(PARALLAX_MAX_PX, px))
}

/** Media queries that mirror the CSS visible set: F2, F4 always; F3 from 768; F1 from 1280; none on short landscape. */
const SHOWN: Record<1 | 2 | 3 | 4, string> = {
  1: "(min-width: 1280px) and (min-height: 480px)",
  2: "(min-height: 480px)",
  3: "(min-width: 768px) and (min-height: 480px)",
  4: "(min-height: 480px)",
}
export function fragmentShown(n: 1 | 2 | 3 | 4): boolean {
  return window.matchMedia(SHOWN[n]).matches
}

/**
 * Entrance animations for the visible fragment cards, planned with the frame
 * so Replay re-runs them and the player's pause and finish cover them.
 */
export function planFragmentEntrances(cards: Iterable<HTMLElement>): PlannedAnimation[] {
  const planned: PlannedAnimation[] = []
  for (const card of cards) {
    const n = Number(card.dataset.fragment) as 1 | 2 | 3 | 4
    const delay = FRAGMENT_ENTRANCE_MS[n]
    if (delay === undefined || !fragmentShown(n)) continue
    planned.push({
      element: card,
      keyframes: [
        { opacity: 0, transform: "translateY(8px) scale(0.96)" },
        { opacity: 1, transform: "none" },
      ],
      options: { delay, duration: DURATION.fragmentIn, easing: EASE_EMPHASIZED, fill: "backwards", composite: "replace" },
    })
  }
  return planned
}
