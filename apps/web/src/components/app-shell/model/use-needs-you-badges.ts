import { useQuery } from "@tanstack/react-query"

import { submissionStatusQueryOptions, submissionSummaryQueryOptions } from "@/entities/application"
import type { NeedsCounts } from "./nav-groups"

/**
 * Counts behind the Needs you strip and the group badges, from one summary request:
 * Blocked, same-company holds, Uncertain, and samples awaiting review until the gate passes.
 * A 409 `feature_not_yet_available` leaves the query without data, which reads as zero.
 */
export function useNeedsYouCounts(): NeedsCounts {
  const { data } = useQuery(submissionSummaryQueryOptions())
  const status = useQuery(submissionStatusQueryOptions())
  const gatePending = status.data !== undefined && status.data.gatePassedAt === null
  return {
    blocked: data?.blocked,
    sameCompany: data?.held,
    uncertain: data?.uncertain,
    sample: gatePending ? data?.samples.awaitingReview : undefined,
  }
}
