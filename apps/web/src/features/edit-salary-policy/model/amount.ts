import { SALARY_AMOUNT_MAX } from "@eve/contracts"

/** C-VAL-SAL-1 to C-VAL-SAL-4 (design-spec.r3). */
export const SALARY_AMOUNT_ERRORS = {
  notANumber: "Enter an amount like 48000 or 4000.50.", // C-VAL-SAL-1
  notPositive: "Enter an amount greater than 0.", // C-VAL-SAL-2
  tooManyDecimals: "Use at most 2 decimal places, like 4000.50.", // C-VAL-SAL-3
  tooLarge: "Enter 100,000,000 or less.", // C-VAL-SAL-4
} as const

export type AmountResult = { ok: true; amount: number } | { ok: false; error: string }

/** A plain decimal: optional minus, digits, optional fraction. No exponent, no "+". */
const DECIMAL = /^(-?)(\d+(?:\.(\d*))?|\.(\d+))$/

/**
 * Checks a typed salary amount the way the contract accepts it, in the
 * design's order, first match wins: not a number, not above 0, more than 2
 * decimals, over 100,000,000. Thousands separators and spaces are removed
 * first. Decimals are counted in the typed text, never from a float, so
 * "0.07" and "4800.10" pass (CR2-03).
 */
export function checkAmount(input: string): AmountResult {
  const normalized = input.replace(/[,\s]/g, "")
  const match = DECIMAL.exec(normalized)
  if (!match) return { ok: false, error: SALARY_AMOUNT_ERRORS.notANumber }
  const amount = Number(normalized)
  if (match[1] === "-" || amount <= 0) return { ok: false, error: SALARY_AMOUNT_ERRORS.notPositive }
  const decimals = (match[3] ?? match[4] ?? "").length
  if (decimals > 2) return { ok: false, error: SALARY_AMOUNT_ERRORS.tooManyDecimals }
  if (amount > SALARY_AMOUNT_MAX) return { ok: false, error: SALARY_AMOUNT_ERRORS.tooLarge }
  return { ok: true, amount }
}
