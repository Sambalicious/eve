/**
 * What the Retention section on `/privacy` shows (PRD E5.2, E5.5, E4.6, E6.4),
 * mapped from `GET /v1/retention` (api-contract v1.17.0). Every date is a WAT
 * calendar date `YYYY-MM-DD`; format it with `formatWatDate`, never through
 * the browser time zone.
 */
export interface RetentionFacts {
  readonly dueNext30Days: { readonly count: number; readonly earliestOn: string | null }
  readonly waitingForDecisionCount: number
  /** While the launch grace lasts (E4.6), the date automatic deletion starts; else null. */
  readonly graceEndsOn: string | null
  /** The latest failed run with no later completed run (E6.4, C-RET-9); else null. */
  readonly lastFailureOn: string | null
}

/** `GET /v1/applications?retention=…` (E5.7). Anything else in the URL means no filter. */
export type RetentionFilter = "due" | "waiting"
