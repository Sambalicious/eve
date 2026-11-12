import { useQuery } from "@tanstack/react-query"

import { needsYouEntry } from "@/components/app-shell"
import { submissionStatusQueryOptions, submissionSummaryQueryOptions } from "@/entities/application"

/** The Needs you rows for Home, from the same summary the nav reads. Null when nothing waits. */
export function useHomeNeedsYou() {
  const summary = useQuery(submissionSummaryQueryOptions()).data
  const status = useQuery(submissionStatusQueryOptions()).data
  return needsYouEntry({
    blocked: summary?.blocked,
    sameCompany: summary?.held,
    uncertain: summary?.uncertain,
    sample: status && status.gatePassedAt === null ? summary?.samples.awaitingReview : undefined,
  })
}
