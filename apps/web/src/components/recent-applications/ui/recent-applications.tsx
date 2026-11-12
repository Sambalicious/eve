import { Link } from "react-router-dom"

import { applicationName, boardColumn, boardColumnCopy } from "@/entities/application"
import { homeCopy } from "@/entities/job-posting"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { formatWatDate } from "@/shared/lib/format-wat"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { QuietEmpty, Section } from "@/shared/ui/section"
import { Skeleton } from "@/shared/ui/skeleton"
import { ClipboardList } from "lucide-react"
import { useRecentApplications } from "../model/use-recent-applications"

/** "Recent applications" (AC-1.4): at most five, newest first, each with its one board word, and a link to the board. */
export function RecentApplications() {
  const { rows, isLoading, isError, retry } = useRecentApplications()
  const advanced = isAdvancedOn(useViewer())
  const c = homeCopy.recent
  return (
    <Section
      title={c.heading}
      actions={
        rows.length > 0 && (
          <Link to="/applications" className="text-sm underline underline-offset-4">
            {c.viewAll}
          </Link>
        )
      }
    >
      {isError ? (
        <LoadErrorAlert onRetry={retry} />
      ) : isLoading ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <QuietEmpty icon={<ClipboardList />} title={c.empty} />
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((app) => {
            const word = boardColumnCopy[boardColumn(app, { advanced }).column]
            return (
              <li key={app.id} className="flex items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
                <Link to={`/applications/${app.id}`} className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline" title={applicationName(app)}>
                  {app.roleTitle ?? applicationName(app)}
                  {app.company && <span className="font-normal text-muted-foreground"> · {app.company}</span>}
                </Link>
                <span className="shrink-0 text-[0.8125rem] text-muted-foreground">{word}</span>
                <time dateTime={app.createdAt} className="shrink-0 text-[0.8125rem] text-muted-foreground tabular-nums">
                  {formatWatDate(app.createdAt)}
                </time>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
