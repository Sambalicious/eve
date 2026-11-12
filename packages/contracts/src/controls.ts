import { z } from "zod"

/**
 * v1.11.0 (slice 7): pauses, the monthly cost ceiling and spend
 * (prd.r4.md AC 10.1, 10.2; design-spec r4 F10, C-PAUSE-*, C-COST-*).
 * Money is a two-decimal USD string ("23.40"), rounded up to the cent.
 */
export const CONTROLS_PATH = "/v1/controls"
export const GLOBAL_PAUSE_PATH = "/v1/controls/global-pause"
export const MONTHLY_CEILING_PATH = "/v1/controls/ceiling"

const usd = z.string().regex(/^\d+\.\d{2}$/)

export const spendCategorySchema = z.enum(["hosting", "ai", "browser", "discovery", "email"])
export type SpendCategoryValue = z.infer<typeof spendCategorySchema>

/** E4 / C-COST-1 `{action label}`. */
export const costActionSchema = z.enum(["discovery run", "document generation", "Eligibility and Match check", "form filling", "Career Profile drafting"])
export type CostActionValue = z.infer<typeof costActionSchema>

export const costPauseSchema = z
  .object({
    pausedAt: z.iso.datetime({ offset: true }),
    /** First day of the WAT month that is paused (YYYY-MM-01). */
    month: z.iso.date(),
    /** 00:00 WAT on the 1st of next month, when the pause clears on its own (C-COST-1, C-COST-4). */
    resumesAt: z.iso.datetime({ offset: true }),
    /** The refused action and its estimate; null when the pause came from settled spend going over. */
    nextAction: costActionSchema.nullable(),
    nextActionEstimate: usd.nullable(),
  })
  .strict()
export type CostPause = z.infer<typeof costPauseSchema>

export const controlsSchema = z
  .object({
    /** AC 10.1. Set and cleared only by the Candidate (`PUT /v1/controls/global-pause`). */
    globalPaused: z.boolean(),
    globalPausedAt: z.iso.datetime({ offset: true }).nullable(),
    /** AC 10.2. Set only by the backend; null when off. Independent of `globalPaused`. */
    costPause: costPauseSchema.nullable(),
    spend: z
      .object({
        /** First day of the current WAT month. */
        month: z.iso.date(),
        /** This month's spend: settled actual plus in-flight reservations. */
        spent: usd,
        /** This month's ceiling: USD 50.00 (or the server's lower default) unless raised. */
        ceiling: usd,
        /** The default the ceiling returns to on the 1st (C-COST-5). */
        defaultCeiling: usd,
        /** True when this month's ceiling was raised (C-COST-5 "Raised for …"). */
        raised: z.boolean(),
        /** The most a raised ceiling can be: "100.00" (C-COST-7, C-VAL-COST-4). */
        maxCeiling: usd,
        /** False when the ceiling is already USD 100.00 or spend has reached it (C-COST-9). */
        canRaise: z.boolean(),
        /** Whole percent of the ceiling used, for C-COST-3 at 80 or more. */
        percentUsed: z.int().min(0),
        byCategory: z.object({ hosting: usd, ai: usd, browser: usd, discovery: usd, email: usd }).strict(),
      })
      .strict(),
  })
  .strict()
export type Controls = z.infer<typeof controlsSchema>

export const setGlobalPauseRequestSchema = z.object({ paused: z.boolean() }).strict()
export type SetGlobalPauseRequest = z.infer<typeof setGlobalPauseRequestSchema>

/**
 * Raise this month's ceiling. `month` must be the current WAT month; any other
 * month is `400 bad_request`. `ceiling` is the text the Candidate typed; the
 * backend validates it with the C-VAL-COST order (first match wins).
 */
export const raiseCeilingRequestSchema = z.object({ month: z.iso.date(), ceiling: z.string().max(32) }).strict()
export type RaiseCeilingRequest = z.infer<typeof raiseCeilingRequestSchema>

/**
 * C-VAL-COST-1 to 5, checked in the order 1, 2, 4, 5, 3; the first match wins.
 * A refusal is a `200` with `result: "refused"`, so it never changes `ApiErrorCode`.
 */
export const ceilingRefusalSchema = z.enum(["ceiling_empty", "ceiling_invalid", "ceiling_above_limit", "ceiling_not_above_spend", "ceiling_not_above_current"])
export type CeilingRefusal = z.infer<typeof ceilingRefusalSchema>

export const raiseCeilingResponseSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("raised"),
      controls: controlsSchema,
      /** True when the raise cleared the cost pause (enough room for the refused action). */
      costPauseCleared: z.boolean(),
    })
    .strict(),
  z
    .object({
      result: z.literal("refused"),
      refusal: ceilingRefusalSchema,
      /** The C-VAL-COST text with its amounts filled in, ready to show under the field. */
      message: z.string(),
    })
    .strict(),
])
export type RaiseCeilingResponse = z.infer<typeof raiseCeilingResponseSchema>
