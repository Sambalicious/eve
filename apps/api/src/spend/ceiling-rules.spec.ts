import { describe, expect, it } from "vitest"

import { checkNewCeiling } from "./ceiling-rules.js"

const USD = 1_000_000

describe("C-VAL-COST order, first match wins (cost-ceiling.feature validation outlines)", () => {
  const at = (ceiling: number, spent: number) => ({ currentMicros: ceiling * USD, spentMicros: spent * USD })

  it.each([
    ["", "ceiling_empty"],
    ["   ", "ceiling_empty"],
    ["sixty", "ceiling_invalid"],
    ["60.505", "ceiling_invalid"],
    ["50.00", "ceiling_not_above_current"],
    ["45.00", "ceiling_not_above_current"],
    ["100.01", "ceiling_above_limit"],
    ["9999.99", "ceiling_above_limit"],
    ["10000.00", "ceiling_above_limit"],
  ])("ceiling 50, spend 20: %j -> %s", (input, code) => {
    expect(checkNewCeiling(input, at(50, 20))).toEqual({ ok: false, code })
  })

  it.each([["50.01", 50_010_000], ["100.00", 100_000_000], ["60", 60_000_000]])("accepts %s", (input, micros) => {
    expect(checkNewCeiling(input, at(50, 20))).toEqual({ ok: true, ceilingMicros: micros })
  })

  it("a new ceiling below this month's spend, at or under the current ceiling, is C-VAL-COST-3", () => {
    expect(checkNewCeiling("65.00", at(80, 70))).toEqual({ ok: false, code: "ceiling_not_above_current" })
  })

  it("with reconciled spend above the ceiling, an entry between them is C-VAL-COST-5", () => {
    expect(checkNewCeiling("51.00", at(50, 52.4))).toEqual({ ok: false, code: "ceiling_not_above_spend" })
    expect(checkNewCeiling("45.00", at(50, 52.4))).toEqual({ ok: false, code: "ceiling_not_above_spend" })
    expect(checkNewCeiling("52.41", at(50, 52.4))).toEqual({ ok: true, ceilingMicros: 52_410_000 })
  })

  it("the limit check comes before the too-low checks", () => {
    expect(checkNewCeiling("150", at(50, 52.4))).toEqual({ ok: false, code: "ceiling_above_limit" })
  })
})
