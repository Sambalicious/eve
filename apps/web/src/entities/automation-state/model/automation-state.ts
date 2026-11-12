/** Pauses, the monthly ceiling and spend as the dashboard uses them (`GET /v1/controls`, v1.11.0). Money is a two-decimal USD string. */

export type SpendCategory = "hosting" | "ai" | "browser" | "discovery" | "email"

export const SPEND_CATEGORIES: readonly SpendCategory[] = ["hosting", "ai", "browser", "discovery", "email"]

export interface CostPause {
  readonly pausedAt: string
  /** 00:00 WAT on the 1st of next month (C-COST-1, C-COST-4). */
  readonly resumesAt: string
}

export interface MonthlySpend {
  /** First day of the current WAT month, `YYYY-MM-01`. */
  readonly month: string
  readonly spent: string
  readonly ceiling: string
  readonly defaultCeiling: string
  readonly raised: boolean
  readonly maxCeiling: string
  readonly canRaise: boolean
  readonly percentUsed: number
  readonly byCategory: Readonly<Record<SpendCategory, string>>
}

export interface AutomationState {
  readonly globalPaused: boolean
  /** Null when paid automation isn't paused for cost. Set only by the backend. */
  readonly costPause: CostPause | null
  readonly spend: MonthlySpend
}

/** Why a raise was refused, with the backend's C-VAL-COST text. */
export type RaiseCeilingResult =
  | { readonly kind: "raised"; readonly state: AutomationState; readonly costPauseCleared: boolean }
  | { readonly kind: "refused"; readonly message: string }

/** C-COST-3 shows at 80% or more. */
export function isNearCeiling(spend: MonthlySpend): boolean {
  return spend.percentUsed >= 80
}
