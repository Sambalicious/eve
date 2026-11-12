import type { CeilingRefusal } from "@eve/contracts"

import { MAX_CEILING_MICROS, formatUsd, parseUsdAmount } from "./spend-math.js"

/** design-spec r4 C-VAL-COST-1 to 5, exact strings with their amounts. */
export function ceilingRefusalMessage(code: CeilingRefusal, month: Readonly<{ currentMicros: number; spentMicros: number }>): string {
  const ceiling = formatUsd(month.currentMicros)
  const spent = formatUsd(month.spentMicros)
  switch (code) {
    case "ceiling_empty":
      return "Enter the new ceiling in USD."
    case "ceiling_invalid":
      return "Enter an amount like 60 or 62.50."
    case "ceiling_above_limit":
      return "Enter USD 100.00 or less. That's the most this month's ceiling can be."
    case "ceiling_not_above_spend":
      return `This month's spend is already USD ${spent}, above the current ceiling of USD ${ceiling}. Enter more than USD ${spent} so there's room for the next paid action.`
    case "ceiling_not_above_current":
      return `Enter more than USD ${ceiling}, this month's current ceiling.`
  }
}

/**
 * design-spec r4 F10 "Raise this month's ceiling", step 2: C-VAL-COST-1, 2, 4,
 * 5, 3 in that order, first match wins. C-VAL-COST-5 applies only when spend is
 * already above the current ceiling; it then covers every entry at or below spend.
 */
export function checkNewCeiling(
  input: string,
  month: Readonly<{ currentMicros: number; spentMicros: number }>
): Readonly<{ ok: true; ceilingMicros: number }> | Readonly<{ ok: false; code: CeilingRefusal }> {
  const text = input.trim()
  if (text === "") return { ok: false, code: "ceiling_empty" }
  const micros = parseUsdAmount(text)
  if (micros === null) return { ok: false, code: "ceiling_invalid" }
  if (micros > MAX_CEILING_MICROS) return { ok: false, code: "ceiling_above_limit" }
  if (month.spentMicros > month.currentMicros && micros <= month.spentMicros) return { ok: false, code: "ceiling_not_above_spend" }
  if (micros <= month.currentMicros) return { ok: false, code: "ceiling_not_above_current" }
  return { ok: true, ceilingMicros: micros }
}
