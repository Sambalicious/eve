import { Link } from "react-router-dom"

import {
  careerProfileCopy,
  VersionStatusBadge,
  type ProfileVersionSummary,
} from "@/entities/career-profile"
import { formatWatDate } from "@/shared/lib/format-wat"

/**
 * "Version history" (F1 step 3b): every version, newest first, with status,
 * created and approved dates. Selecting a version opens it read-only. "Used by
 * {k} Applications" is omitted: the contract has no per-version count yet.
 */
export function VersionHistory({
  history,
}: {
  history: readonly ProfileVersionSummary[]
}) {
  if (history.length === 0) return null
  return (
    <section
      aria-labelledby="version-history-heading"
      className="flex flex-col gap-3 border-t pt-7"
    >
      <h2
        id="version-history-heading"
        className="text-[0.9375rem] font-semibold tracking-[-0.01em]"
      >
        {careerProfileCopy.versionHistory}
      </h2>
      <ol className="flex flex-col divide-y">
        {history.map((entry) => (
          <li
            key={entry.version}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
          >
            <Link
              to={`/profile?version=${entry.version}`}
              className="text-sm font-medium underline-offset-4 hover:underline"
            >
              {careerProfileCopy.versionLabel(entry.version)}
            </Link>
            <VersionStatusBadge status={entry.status} />
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {careerProfileCopy.historyDates(
                formatWatDate(entry.createdAt),
                entry.approvedAt && formatWatDate(entry.approvedAt)
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
