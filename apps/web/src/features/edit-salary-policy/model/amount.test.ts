import { isValidSalaryAmount } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { checkAmount, SALARY_AMOUNT_ERRORS as E } from "./amount"

describe("checkAmount (C-VAL-SAL-1 to C-VAL-SAL-4, first match wins)", () => {
  it.each([
    ["", E.notANumber],
    ["forty", E.notANumber],
    ["1e5", E.notANumber],
    ["12.3.4", E.notANumber],
    ["0", E.notPositive],
    ["0.00", E.notPositive],
    ["-1.00", E.notPositive],
    ["-5", E.notPositive],
    // A negative amount with 3 decimals is "not above 0" first.
    ["-0.005", E.notPositive],
    ["4800.105", E.tooManyDecimals],
    ["0.075", E.tooManyDecimals],
    ["4800.100", E.tooManyDecimals],
    // Over the maximum but with 3 decimals: the decimals rule comes first.
    ["100000000.001", E.tooManyDecimals],
    ["100000000.01", E.tooLarge],
    ["200,000,000", E.tooLarge],
  ])("refuses %j with %j", (input, error) => {
    expect(checkAmount(input)).toEqual({ ok: false, error })
  })

  it.each([
    ["0.07", 0.07],
    ["0.29", 0.29],
    ["4800.10", 4800.1],
    ["0.01", 0.01],
    ["4800", 4800],
    ["48,000", 48000],
    [" 5 000.5 ", 5000.5],
    ["4800.", 4800],
    [".5", 0.5],
    ["100000000", 100_000_000],
  ])("accepts %j as %d", (input, amount) => {
    expect(checkAmount(input)).toEqual({ ok: true, amount })
  })

  it("agrees with the contract for every cent value from 0.01 to 1,000.00", () => {
    const disagreements: string[] = []
    for (let cents = 1; cents <= 100_000; cents++) {
      const typed = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
      const result = checkAmount(typed)
      if (!result.ok || !isValidSalaryAmount(result.amount)) disagreements.push(typed)
    }
    expect(disagreements).toEqual([])
  })
})
