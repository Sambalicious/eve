import { applicationsRetentionFilterSchema, RETENTION_PATH, retentionResponseSchema } from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { RetentionFacts, RetentionFilter } from "../model/retention"

export async function fetchRetention(): Promise<RetentionFacts> {
  const response = await apiRequest(RETENTION_PATH)
  const body = retentionResponseSchema.parse(await response.json())
  return {
    dueNext30Days: { count: body.dueNext30Days.count, earliestOn: body.dueNext30Days.earliestOn },
    waitingForDecisionCount: body.waitingForDecision.count,
    graceEndsOn: body.graceEndsOn,
    lastFailureOn: body.lastFailure?.watDate ?? null,
  }
}

/**
 * The `retention` URL value as the API reads it: exactly `due` or `waiting`,
 * once. An empty, unknown or repeated value is no filter (E5.7), so the page
 * and the API agree.
 */
export function parseRetentionFilter(params: URLSearchParams): RetentionFilter | null {
  const values = params.getAll("retention")
  if (values.length !== 1) return null
  const parsed = applicationsRetentionFilterSchema.safeParse(values[0])
  return parsed.success ? parsed.data : null
}
