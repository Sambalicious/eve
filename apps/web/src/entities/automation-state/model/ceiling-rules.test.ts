import { describe, expect, it } from "vitest"

import { ceilingProblem, ceilingDifference, normalizeUsd } from "./ceiling-rules"

const at = (spent: string, ceiling: string) => ({ spent, ceiling, maxCeiling: "100.00" })

describe("ceilingProblem (C-VAL-COST order 1, 2, 4, 5, 3; cost-ceiling.feature)", () => {
  it.each([
    ["", "Enter the new ceiling in USD."],
    ["   ", "Enter the new ceiling in USD."],
    ["sixty", "Enter an amount like 60 or 62.50."],
    ["60.505", "Enter an amount like 60 or 62.50."],
    ["-60", "Enter an amount like 60 or 62.50."],
    ["50.00", "Enter more than USD 50.00, this month's current ceiling."],
    ["45.00", "Enter more than USD 50.00, this month's current ceiling."],
  ])("ceiling 50.00, input %j: %s", (input, message) => {
    expect(ceilingProblem(input, at("20.00", "50.00"))).toBe(message)
  })

  it.each(["100.01", "9999.99", "10000.00"])("above the USD 100.00 limit: %s gets C-VAL-COST-4", (input) => {
    expect(ceilingProblem(input, at("20.00", "50.00"))).toBe("Enter USD 100.00 or less. That's the most this month's ceiling can be.")
  })

  it.each(["50.01", "100.00", "60", "62.5"])("accepted: %s", (input) => {
    expect(ceilingProblem(input, at("20.00", "50.00"))).toBeNull()
  })

  it("spend at or below the ceiling: a value below spend still gets C-VAL-COST-3 (raised 80.00, spend 70.00, entry 65.00)", () => {
    expect(ceilingProblem("65.00", at("70.00", "80.00"))).toBe("Enter more than USD 80.00, this month's current ceiling.")
  })

  it("spend above the ceiling after reconciliation: entries at or below spend get C-VAL-COST-5", () => {
    const five = "This month's spend is already USD 52.40, above the current ceiling of USD 50.00. Enter more than USD 52.40 so there's room for the next paid action."
    expect(ceilingProblem("51.00", at("52.40", "50.00"))).toBe(five)
    expect(ceilingProblem("49.00", at("52.40", "50.00"))).toBe(five)
    expect(ceilingProblem("52.40", at("52.40", "50.00"))).toBe(five)
    expect(ceilingProblem("52.41", at("52.40", "50.00"))).toBeNull()
  })
})

describe("normalizeUsd and ceilingDifference", () => {
  it("prints two decimals and subtracts in cents", () => {
    expect(normalizeUsd("60")).toBe("60.00")
    expect(normalizeUsd("62.5")).toBe("62.50")
    expect(ceilingDifference("60", "50.00")).toBe("10.00")
    expect(ceilingDifference("50.05", "50.00")).toBe("0.05")
  })
})
