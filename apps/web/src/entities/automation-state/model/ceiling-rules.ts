import { automationCopy } from "./copy"

const AMOUNT = /^\d+(\.\d{1,2})?$/

/** Whole cents of a two-decimal USD string; amounts are checked with AMOUNT first. */
function cents(usd: string): number {
  const [whole, fraction = ""] = usd.trim().split(".")
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
}

function fromCents(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`
}

/** "60" becomes "60.00", for C-CONFIRM-18 and C-COST-8. */
export function normalizeUsd(input: string): string {
  return fromCents(cents(input))
}

/** C-CONFIRM-18 `{difference}`: the new ceiling minus the current one. */
export function ceilingDifference(next: string, current: string): string {
  return fromCents(cents(next) - cents(current))
}

/**
 * The raise dialog's client-side check (F10, raise step 2), first match wins:
 * C-VAL-COST-1, 2, 4, 5 (only when spend is above the ceiling), 3. The backend
 * applies the same rules and its refusal message is the source of truth.
 */
export function ceilingProblem(
  input: string,
  spend: { readonly spent: string; readonly ceiling: string; readonly maxCeiling: string }
): string | null {
  const v = automationCopy.validation
  const text = input.trim()
  if (text === "") return v.empty
  if (!AMOUNT.test(text)) return v.invalid
  const value = cents(text)
  if (value > cents(spend.maxCeiling)) return v.aboveLimit
  if (cents(spend.spent) > cents(spend.ceiling) && value <= cents(spend.spent)) return v.notAboveSpend(spend.spent, spend.ceiling)
  if (value <= cents(spend.ceiling)) return v.notAboveCurrent(spend.ceiling)
  return null
}
