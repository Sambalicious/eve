import { Minus } from "lucide-react"

import { applicationName, isSampleSubmitting, SubmissionStatusBadge, submissionCopy, type SampleRow } from "@/entities/application"
import { coveragePercent, jobPostingCopy, UnverifiedLabels } from "@/entities/job-posting"
import { Badge } from "@/shared/ui/badge"
import { ButtonLink } from "@/shared/ui/button-link"

const g = submissionCopy.gate
const sc = submissionCopy.sample

/**
 * One tab's sample rows (F2 step 2): role and company, requisition ID,
 * Application System, Match summary, Unverified labels, status, and why a
 * sample doesn't count. The page shows the tab's empty state, so `rows` is never empty.
 */
export function SampleList({ tab, rows, countingSamples }: { tab: "awaiting" | "approved" | "rejected"; rows: SampleRow[]; countingSamples: number }) {
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {rows.map(({ application, submission, applicationSystem, match, unverifiedLabels }) => {
        // A sample the worker is still submitting hasn't had the chance to count yet (v1.8.0).
        const doesntCount = tab === "approved" && submission.sample?.counts === false && !isSampleSubmitting(submission)
        const markedNotSubmitted = submission.state === "not_submitted"
        return (
          <li key={application.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium [overflow-wrap:anywhere]">{applicationName(application)}</span>
              {(application.roleTitle || application.company) && (
                <span className="font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{application.requisitionId}</span>
              )}
              <span className="text-sm text-muted-foreground">{applicationSystem}</span>
              {match && match.total > 0 && (
                <span className="text-sm tabular-nums">{jobPostingCopy.matchCoverage(match.covered, match.total, coveragePercent(match.covered, match.total))}</span>
              )}
              {unverifiedLabels.length > 0 && <UnverifiedLabels labels={unverifiedLabels} />}
              {tab === "approved" && (
                <div className="flex flex-wrap items-center gap-2">
                  <SubmissionStatusBadge submission={submission} />
                  {doesntCount && (
                    <Badge variant="outline">
                      <Minus aria-hidden="true" />
                      {submissionCopy.status.doesntCount}
                    </Badge>
                  )}
                </div>
              )}
              {doesntCount && (
                <p className="text-sm text-muted-foreground">
                  {markedNotSubmitted
                    ? // Rows marked before contract v1.7.0 have no mark date; their last change stands in.
                      sc.markedNotSubmittedLine(submission.markedNotSubmittedAt ?? application.updatedAt)
                    : sc.doesntCount(countingSamples)}
                </p>
              )}
              {tab === "rejected" && submission.sample?.rejectReason && (
                <p className="text-sm [overflow-wrap:anywhere]">
                  <span className="text-muted-foreground">{sc.rejectReasonLabel}</span> {submission.sample.rejectReason}
                </p>
              )}
            </div>
            <ButtonLink to={`/activation/${application.id}`} variant={tab === "awaiting" ? "default" : "outline"} size="sm" aria-label={`${g.reviewSample}, ${applicationName(application)}`}>
              {g.reviewSample}
            </ButtonLink>
          </li>
        )
      })}
    </ul>
  )
}
