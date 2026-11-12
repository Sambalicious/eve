import { describe, expect, it } from "vitest"

import { formatSalary } from "./salary-display.js"

describe("formatSalary", () => {
  it.each([
    ["48000.00", "USD", "year", "USD 48,000 per year"],
    ["5000.00", "USD", "month_net", "USD 5,000 per month net"],
    ["4000.50", "EUR", "month", "EUR 4,000.50 per month"],
  ] as const)("%s %s %s -> %s", (amount, currency, period, expected) => {
    expect(formatSalary(amount, currency, period)).toBe(expected)
  })
})
