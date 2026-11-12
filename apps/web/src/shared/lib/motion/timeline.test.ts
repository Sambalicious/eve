import { describe, expect, it } from "vitest"

import { resolveTimeline, totalDuration, validateTimeline, type Step } from "./timeline"
import { EASE_EMPHASIZED, EASE_STANDARD } from "./tokens"

const fade: Step = { target: "a", start: 100, duration: 200, easing: EASE_STANDARD, from: { opacity: 0 }, to: { opacity: 1 } }

describe("resolveTimeline", () => {
  it("expands a group into per-element delays by stagger", () => {
    const rule: Step = { ...fade, target: "rule", stagger: 70 }
    const resolved = resolveTimeline([rule], { rule: 3 })
    expect(resolved.map((r) => r.delay)).toEqual([100, 170, 240])
    expect(resolved.map((r) => r.index)).toEqual([0, 1, 2])
    expect(resolved[0]).toMatchObject({
      target: "rule",
      duration: 200,
      easing: EASE_STANDARD,
      fill: "backwards",
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
    })
  })

  it("adds the transform origin to both keyframes", () => {
    const badge: Step = { ...fade, from: { opacity: 0, transform: "scale(0.92)" }, to: { opacity: 1, transform: "none" }, origin: "left center" }
    const [resolved] = resolveTimeline([badge], { a: 1 })
    expect(resolved.keyframes).toEqual([
      { opacity: 0, transform: "scale(0.92)", transformOrigin: "left center" },
      { opacity: 1, transform: "none", transformOrigin: "left center" },
    ])
  })

  it("skips a step whose target has no elements", () => {
    expect(resolveTimeline([fade], {})).toEqual([])
  })

  it("totalDuration is the latest end", () => {
    const rule: Step = { ...fade, target: "rule", stagger: 70 }
    expect(totalDuration(resolveTimeline([fade, rule], { a: 1, rule: 5 }))).toBe(100 + 4 * 70 + 200)
  })
})

describe("validateTimeline", () => {
  const counts = { a: 1 }
  const errors = (step: Partial<Step>) => validateTimeline([{ ...fade, ...step }], counts)

  it("accepts a step inside every rule", () => {
    expect(errors({})).toEqual([])
    expect(errors({ easing: EASE_EMPHASIZED, from: { opacity: 0, transform: "translateY(6px) scale(0.92)" } })).toEqual([])
  })

  it.each([
    ["a width keyframe", { from: { width: "0px" } }],
    ["a box-shadow keyframe", { to: { boxShadow: "none" } }],
    ["scale(0.5)", { from: { opacity: 0, transform: "scale(0.5)" } }],
    ["420 ms", { duration: 420 }],
    ["140 ms", { duration: 140 }],
    ["a 90 ms stagger", { stagger: 90 }],
    ["ease-in", { easing: "ease-in" }],
  ] as const)("rejects %s", (_label, step) => {
    expect(errors(step as Partial<Step>).length).toBeGreaterThan(0)
  })

  it("rejects a total over 5000 ms", () => {
    expect(errors({ start: 4900 })).toEqual(["total 5100 ms is over 5000 ms"])
  })
})
