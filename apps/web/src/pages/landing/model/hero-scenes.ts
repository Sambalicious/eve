import { EASE_EMPHASIZED as E, EASE_STANDARD as S, STAGGER_HERO, type Step } from "@/shared/lib/motion"

const y = (px: number) => `translateY(${px}px)`

/**
 * Design-spec r1 4.4 (restated in r2): six scenes, 3,260 ms, transform and
 * opacity only. Below 768px only three rules render, so the group expands to
 * three and the last rule badge lands at 820 ms; later scenes keep their starts.
 */
export const HERO_SCENES: readonly Step[] = [
  { target: "posting", start: 0, duration: 360, easing: E, from: { opacity: 0, transform: y(12) }, to: { opacity: 1, transform: "none" } },
  { target: "elig-label", start: 360, duration: 200, easing: S, from: { opacity: 0 }, to: { opacity: 1 } },
  { target: "rule", start: 420, duration: 240, easing: E, stagger: STAGGER_HERO, from: { opacity: 0, transform: y(6) }, to: { opacity: 1, transform: "none" } },
  { target: "rule-badge", start: 480, duration: 200, easing: E, stagger: STAGGER_HERO, origin: "left center", from: { opacity: 0, transform: "scale(0.92)" }, to: { opacity: 1, transform: "none" } },
  { target: "match-badge", start: 1060, duration: 260, easing: E, origin: "left center", from: { opacity: 0, transform: "scale(0.94)" }, to: { opacity: 1, transform: "none" } },
  { target: "match-line", start: 1120, duration: 240, easing: S, from: { opacity: 0, transform: y(4) }, to: { opacity: 1, transform: "none" } },
  { target: "fact", start: 1460, duration: 300, easing: E, from: { opacity: 0, transform: y(8) }, to: { opacity: 1, transform: "none" } },
  { target: "arrow", start: 1640, duration: 200, easing: S, from: { opacity: 0, transform: y(-4) }, to: { opacity: 1, transform: "none" } },
  { target: "line-label", start: 1700, duration: 200, easing: S, from: { opacity: 0 }, to: { opacity: 1 } },
  { target: "chunk", start: 1760, duration: 260, easing: E, stagger: 60, from: { opacity: 0, transform: y(6) }, to: { opacity: 1, transform: "none" } },
  { target: "status-row", start: 2140, duration: 200, easing: S, from: { opacity: 0 }, to: { opacity: 1 } },
  // Held at opacity 1 by the backwards fill from 2140 until it leaves at 2440; at rest its CSS is opacity 0.
  { target: "status-prev", start: 2440, duration: 160, easing: S, from: { opacity: 1, transform: "none" }, to: { opacity: 0, transform: y(-6) } },
  { target: "status-next", start: 2520, duration: 280, easing: E, origin: "left center", from: { opacity: 0, transform: "translateY(6px) scale(0.96)" }, to: { opacity: 1, transform: "none" } },
  { target: "evidence", start: 2620, duration: 240, easing: S, from: { opacity: 0, transform: y(4) }, to: { opacity: 1, transform: "none" } },
  { target: "mail", start: 2880, duration: 380, easing: E, origin: "bottom center", from: { opacity: 0, transform: "translateY(16px) scale(0.97)" }, to: { opacity: 1, transform: "none" } },
]

/** Element counts per group at each layout (the frame markup's `data-a` hooks). */
export function heroCounts(wide: boolean): Record<string, number> {
  const rules = wide ? 5 : 3
  return {
    posting: 1,
    "elig-label": 1,
    rule: rules,
    "rule-badge": rules,
    "match-badge": 1,
    "match-line": 1,
    fact: 1,
    arrow: 1,
    "line-label": 1,
    chunk: 4,
    "status-row": 1,
    "status-prev": 1,
    "status-next": 1,
    evidence: 1,
    mail: 1,
  }
}
