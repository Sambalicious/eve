import { describe, expect, it } from "vitest"

import { SALARY_AMOUNT_MAX, isValidSalaryAmount, setGrossSalaryRequestSchema, setPreferredNetPayRequestSchema } from "./approved-answers.js"

// CR2-03 and the 2026-10-18 decision: greater than 0, at most 2 decimals, at most 100,000,000.
describe("salary amount rule", () => {
  it("accepts every cent amount from 0.01 to 10,000.00 (binary float rounding must not matter)", () => {
    const refused: number[] = []
    for (let cents = 1; cents <= 1_000_000; cents++) {
      const amount = cents / 100
      if (!isValidSalaryAmount(amount)) refused.push(amount)
    }
    expect(refused).toEqual([])
  })

  it.each([0.07, 0.14, 0.28, 0.29, 0.01, 4800.1, 4800, 48000, 5000, 99_999_999.99, SALARY_AMOUNT_MAX])("accepts %s on every card", (amount) => {
    expect(setGrossSalaryRequestSchema.safeParse({ amount, period: "year" }).success).toBe(true)
    expect(setPreferredNetPayRequestSchema.safeParse({ amount }).success).toBe(true)
  })

  it.each([0, -1, -0.01, 4800.105, 0.075, 0.001, 100_000_000.01, 1e9, Number.NaN, Number.POSITIVE_INFINITY, 1e-7])("refuses %s on every card", (amount) => {
    expect(setGrossSalaryRequestSchema.safeParse({ amount, period: "year" }).success).toBe(false)
    expect(setPreferredNetPayRequestSchema.safeParse({ amount }).success).toBe(false)
  })

  it("refuses a numeric string; amounts are JSON numbers", () => {
    expect(setPreferredNetPayRequestSchema.safeParse({ amount: "48000" }).success).toBe(false)
  })
})
