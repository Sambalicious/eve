import { Link } from "react-router-dom"

import {
  AttributionLink,
  jobPostingCopy,
  PastedDescriptionBadge,
  PostingAge,
  postingsCopy,
  PostingStatusBadge,
  reasonLine,
  showsAgeLabel,
  TechnologiesNotCheckedBadge,
  UnverifiedLabels,
  type JobPosting,
} from "@/entities/job-posting"
import { postingName } from "../model/posting-name"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table"

/**
 * Posting table (md and up) and card list (below 768px). The first cell holds
 * the link to the detail page; rows aren't focusable. Each row shows its skip
 * or failure reason in place, so the Skipped tab explains itself.
 */
export function PostingList({
  postings,
  showRank,
}: {
  postings: readonly JobPosting[]
  showRank: boolean
}) {
  return (
    <>
      <div
        className="hidden overflow-x-auto md:block"
        tabIndex={0}
        role="region"
        aria-label="Job Postings, scrolls horizontally"
      >
        <Table scroll={false}>
          <TableHeader>
            <TableRow>
              {showRank && <TableHead className="w-12">Rank</TableHead>}
              <TableHead>Role</TableHead>
              <TableHead className="hidden lg:table-cell">
                {postingsCopy.list.familyColumn}
              </TableHead>
              <TableHead>Eligibility</TableHead>
              <TableHead>Match</TableHead>
              <TableHead className="hidden lg:table-cell">
                {jobPostingCopy.applicationSystemLabel}
              </TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {postings.map((posting) => (
              <TableRow key={posting.id} className="[&>td]:align-top">
                {showRank && (
                  <TableCell className="tabular-nums">
                    {posting.rank ?? ""}
                  </TableCell>
                )}
                <TableCell className="max-w-[28rem] min-w-56 whitespace-normal">
                  <PostingTitle posting={posting} />
                </TableCell>
                <TableCell className="hidden whitespace-normal lg:table-cell">
                  {posting.roleFamily
                    ? postingsCopy.family[posting.roleFamily]
                    : ""}
                </TableCell>
                <TableCell className="min-w-40 whitespace-normal">
                  <EligibilitySummary posting={posting} />
                </TableCell>
                <TableCell className="tabular-nums">
                  {coverageText(posting)}
                </TableCell>
                <TableCell className="hidden max-w-40 whitespace-normal [overflow-wrap:anywhere] lg:table-cell">
                  {/* Design r2 B4 (DR-04): no link, no system; the synthetic "none" never shows. */}
                  {posting.applyUrl === null ? null : posting.applicationSystem}
                </TableCell>
                <TableCell className="min-w-48 whitespace-normal">
                  <StatusCell posting={posting} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul
        className="flex flex-col divide-y md:hidden"
        aria-label="Job Postings"
      >
        {postings.map((posting) => (
          <li key={posting.id} className="flex flex-col gap-2 py-4">
            <div className="flex items-start gap-3">
              {showRank && posting.rank !== null && (
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  <span className="sr-only">Rank </span>
                  {posting.rank}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <PostingTitle posting={posting} />
              </div>
            </div>
            <EligibilitySummary posting={posting} />
            {posting.coverage && (
              <p className="text-sm tabular-nums">
                Match: {coverageText(posting)}
              </p>
            )}
            <StatusCell posting={posting} />
          </li>
        ))}
      </ul>
    </>
  )
}

function PostingTitle({ posting }: { posting: JobPosting }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Link
        to={`/postings/${posting.id}`}
        data-posting-link={posting.id}
        className="font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline"
      >
        {postingName(posting)}
      </Link>
      {(posting.attribution || showsAgeLabel(posting.postedDate)) && (
        // design-spec.r1 B2: "via Himalayas · Posted 45 days ago" on one meta line that wraps, never truncates.
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {posting.attribution && <AttributionLink attribution={posting.attribution} />}
          {/* One flex item: the separator wraps with the age label, never dangles at a line end (DP-3). */}
          {showsAgeLabel(posting.postedDate) && (
            <span data-slot="posting-age-group" className="inline-flex items-center gap-x-1.5">
              {posting.attribution && (
                <span aria-hidden="true" className="text-xs text-muted-foreground">
                  ·
                </span>
              )}
              <PostingAge postedDate={posting.postedDate} />
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function EligibilitySummary({ posting }: { posting: JobPosting }) {
  if (
    posting.status === "checking" ||
    posting.status === "waiting_to_be_checked" ||
    posting.status === "not_checked" ||
    posting.status === "evaluation_failed"
  ) {
    return null
  }
  // Only postings that passed Eligibility get a summary; an excluded row's reason line names the violated rule.
  if (posting.status === "excluded") return null
  // These skips happen before Eligibility runs, so there is nothing to summarise (EPIC-0002 DP-B1-04:
  // excluded_role_family and keyword_mismatch are R6-2 steps 2 and 3, before Eligibility).
  if (
    posting.skipReason === "unsupported_application_system" ||
    posting.skipReason === "not_software_role" ||
    posting.skipReason === "excluded_role_family" ||
    posting.skipReason === "keyword_mismatch"
  )
    return null
  return <UnverifiedLabels labels={posting.unverifiedLabels} />
}

function StatusCell({ posting }: { posting: JobPosting }) {
  const reason = reasonLine(posting)
  // Design-spec decision on PRD Open question 5: ranked rows only.
  const notChecked = posting.status === "ranked" && posting.technologiesNotChecked
  // The one status word always shows (R4). Unsupported systems get the detail line below, not a badge.
  const hasBadges = true
  return (
    <div className="flex flex-col items-start gap-1">
      {hasBadges && (
        <div className="flex flex-wrap gap-1">
          <PostingStatusBadge posting={posting} />
          {posting.pastedDescription && <PastedDescriptionBadge />}
          {notChecked && <TechnologiesNotCheckedBadge />}
        </div>
      )}
      {reason && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {reason}
        </p>
      )}
    </div>
  )
}

function coverageText(posting: JobPosting): string {
  const ats = posting.coverage?.atsFit
  return posting.coverage
    ? `${posting.coverage.covered.toLocaleString("en-US")} of ${posting.coverage.total.toLocaleString("en-US")}${ats === null || ats === undefined ? "" : ` · ATS ${ats}%`}`
    : ""
}
