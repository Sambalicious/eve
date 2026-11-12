import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { resolveTimeline, totalDuration, validateTimeline } from "@/shared/lib/motion"
import { HeroFrame } from "../ui/hero-frame"
import { heroCounts, HERO_SCENES } from "./hero-scenes"

describe("hero scenes (design-spec r1 4.4)", () => {
  it("runs 3,260 ms at every width", () => {
    expect(totalDuration(resolveTimeline(HERO_SCENES, heroCounts(true)))).toBe(3260)
    expect(totalDuration(resolveTimeline(HERO_SCENES, heroCounts(false)))).toBe(3260)
  })

  it("lands the last rule badge at 960 ms wide and 820 ms narrow", () => {
    const lastBadgeEnd = (wide: boolean) =>
      Math.max(...resolveTimeline(HERO_SCENES, heroCounts(wide)).filter((a) => a.target === "rule-badge").map((a) => a.delay + a.duration))
    expect(lastBadgeEnd(true)).toBe(960)
    expect(lastBadgeEnd(false)).toBe(820)
  })

  it("breaks no motion rule", () => {
    expect(validateTimeline(HERO_SCENES, heroCounts(true))).toEqual([])
    expect(validateTimeline(HERO_SCENES, heroCounts(false))).toEqual([])
  })

  it("plays the scenes in Eve's order", () => {
    const order = ["posting", "elig-label", "rule", "match-badge", "fact", "chunk", "status-next", "mail"]
    const starts = order.map((target) => HERO_SCENES.find((s) => s.target === target)!.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it("every group in the table exists in the frame markup with the counted elements", () => {
    const { container } = render(<HeroFrame replayHidden />)
    const counts = heroCounts(true)
    for (const scene of HERO_SCENES) {
      expect(container.querySelectorAll(`[data-a="${scene.target}"]`), scene.target).toHaveLength(counts[scene.target])
    }
    expect(container.querySelectorAll('[data-a="rule"][data-wide]')).toHaveLength(2)
  })

  it("the email enters from the bottom edge", () => {
    const mail = HERO_SCENES.find((s) => s.target === "mail")!
    expect(mail.origin).toBe("bottom center")
    expect(mail.from.transform).toMatch(/translateY\(16px\)/)
  })
})
