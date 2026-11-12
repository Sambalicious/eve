import { useQuery } from "@tanstack/react-query"
import { History } from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"
import { useEffect } from "react"

import { AppShell } from "@/components/app-shell"
import { ApplicationBoard } from "@/components/application-board"
import { ApplicationList } from "@/components/application-list"
import { applicationsQueryOptions, boardUiCopy as b } from "@/entities/application"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { Button } from "@/shared/ui/button"
import { ButtonLink } from "@/shared/ui/button-link"
import { parseRetentionFilter, retentionCopy as c, type RetentionFilter } from "@/entities/retention"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { QuietEmpty, SectionNote } from "@/shared/ui/section"
import { ApplicationsListSkeleton } from "@/components/page-skeletons"

const TITLE = b.title
const VIEW_KEY = "eve-applications-view"

type View = "board" | "list"

/** The remembered choice is a per-browser convenience: any storage failure reads as the default (Board). */
function rememberedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"
  } catch {
    return "board"
  }
}
function remember(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // Not remembered; the URL still carries the choice.
  }
}

const NOTICE: Record<RetentionFilter, string> = {
  due: c["applications.retentionFilter.due"],
  waiting: c["applications.retentionFilter.waiting"],
}

/**
 * Applications (`/applications`), the part slice 7 needs: every Application
 * with details, row checkboxes, "Select all on this page" and the bulk
 * "Delete detailed records ({n})" toolbar, 25 rows per page. Filter tabs, search
 * and the submission columns of F9 are not in this slice (OPEN[frontend-engineer]).
 *
 * Slice 9 (E5.7, B3): `?retention=due|waiting` asks the API for exactly the
 * Applications in that Retention count, earliest expiry first, with a notice
 * (C-RET-12 / C-RET-12w), "Show all Applications" (C-RET-12a) and an empty
 * line (C-RET-12e). Any other value is no filter, as in the API.
 */
export function ApplicationsPage() {
  useDocumentTitle(TITLE)
  const [params, setParams] = useSearchParams()
  const filter = parseRetentionFilter(params)
  const advanced = isAdvancedOn(useViewer())
  // `?view=list` wins; any retention parameter (the E5.7 email links) is a list job, so it opens the List.
  const urlView = params.get("view")
  const view: View = urlView === "list" || urlView === "board" ? urlView : params.has("retention") ? "list" : rememberedView()
  useEffect(() => {
    if (urlView === "list" || urlView === "board") remember(urlView)
  }, [urlView])
  const setView = (next: View) => {
    remember(next)
    setParams((current) => {
      const nextParams = new URLSearchParams(current)
      nextParams.set("view", next)
      return nextParams
    })
  }
  const list = useQuery(applicationsQueryOptions(filter))
  const applications = list.data?.filter((a) => a.detailsDeletedAt === null)
  return (
    <AppShell title={TITLE} description={b.description}>
      <div className="flex w-full max-w-[1120px] flex-col gap-4 px-4 lg:px-6">
        <div role="group" aria-label={b.viewAria} className="flex w-fit gap-1">
          {(["board", "list"] as const).map((value) => (
            <Button key={value} variant={view === value ? "secondary" : "ghost"} size="sm" aria-pressed={view === value} onClick={() => setView(value)}>
              {value === "board" ? b.viewBoard : b.viewList}
            </Button>
          ))}
        </div>
        {filter && (
          <p className="text-sm text-pretty">
            {NOTICE[filter]}{" "}
            <Link
              to="/applications?view=list"
              className="inline-flex font-medium underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {c["applications.retentionFilter.showAll"]}
            </Link>
          </p>
        )}
        {list.isError ? (
          <LoadErrorAlert onRetry={() => void list.refetch()} />
        ) : !applications ? (
          <ApplicationsListSkeleton />
        ) : applications.length === 0 ? (
          filter ? (
            <SectionNote className="text-muted-foreground">{c["applications.retentionFilter.empty"]}</SectionNote>
          ) : (
            <QuietEmpty
              icon={<History />}
              title={b.empty}
              action={<ButtonLink variant="outline" to="/dashboard">{b.emptyAction}</ButtonLink>}
            />
          )
        ) : view === "board" ? (
          <ApplicationBoard applications={applications} advanced={advanced} />
        ) : (
          <ApplicationList key={filter ?? "all"} applications={applications} />
        )}
      </div>
    </AppShell>
  )
}
