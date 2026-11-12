import { ChevronLeft, ChevronRight, Info } from "lucide-react"
import { Link } from "react-router-dom"

import { applicationName, BoardStageBadge, boardUiCopy, OverrideBadge, PastedApplicationBadge, type Application } from "@/entities/application"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { fillCopy, retentionCopy } from "@/entities/retention"
import { DeleteSelectedRecords } from "@/features/delete-detailed-records"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { Checkbox } from "@/shared/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { usePagination } from "../model/use-pagination"
import { useSelection } from "../model/use-selection"

const SELECT_ALL = "Select all on this page"

/**
 * Application table with a checkbox column and the bulk toolbar (Composite
 * blocks, F10 retention step 2). The toolbar appears once a row is selected.
 * Rows whose details were deleted aren't listed here; they live on `/privacy`.
 * Table on md and up, card list below 768px. 25 rows per page (F9 step 1), so
 * "Select all on this page" never passes the server's 100-ID limit (CR7-01).
 * Pages are cut on the client from the full list: the list API has no
 * pagination (OPEN[backend-engineer]). Changing page clears the selection.
 * "Expires" (C-RET-13s) follows "Created"; below 768px the row's details line
 * adds "Expires {date}" (C-RET-14s, E5.7). Rows keep the order they are given.
 */
export function ApplicationList({ applications: all }: { applications: readonly Application[] }) {
  const advanced = isAdvancedOn(useViewer())
  const { page, pageCount, pageItems: applications, goTo } = usePagination(all)
  const selection = useSelection(applications.map((a) => a.id))
  const changePage = (next: number) => {
    selection.clear()
    goTo(next)
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            aria-label={SELECT_ALL}
            checked={selection.allSelected}
            indeterminate={selection.someSelected}
            onCheckedChange={(on) => selection.toggleAll(on)}
          />
          <span aria-hidden="true">{SELECT_ALL}</span>
        </label>
        {selection.selected.length > 0 && (
          <div role="toolbar" aria-label="Selected Applications" className="flex items-center gap-2">
            <DeleteSelectedRecords applicationIds={selection.selected} onDeleted={selection.clear} />
          </div>
        )}
      </div>
      <div className="hidden overflow-x-auto md:block" tabIndex={0} role="region" aria-label="Applications, scrolls horizontally">
        <Table scroll={false}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"><span className="sr-only">Select</span></TableHead>
              <TableHead>Application</TableHead>
              <TableHead>Requisition ID</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  {boardUiCopy.listStage}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        />
                      }
                    >
                      <Info aria-hidden="true" className="size-3.5" />
                      <span className="sr-only">{boardUiCopy.listStageHelp.trigger}</span>
                    </TooltipTrigger>
                    <TooltipContent>{boardUiCopy.listStageHelp.text}</TooltipContent>
                  </Tooltip>
                </span>
              </TableHead>
              <TableHead>Created</TableHead>
              <TableHead>{retentionCopy["applications.columns.expires"]}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((app) => (
              <TableRow key={app.id} className="[&>td]:align-top">
                <TableCell>
                  <RowCheckbox app={app} checked={selection.isSelected(app.id)} onChange={(on) => selection.toggle(app.id, on)} />
                </TableCell>
                <TableCell className="max-w-[28rem] min-w-56 whitespace-normal">
                  <Link to={`/applications/${app.id}`} className="font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline">
                    {applicationName(app)}
                  </Link>
                </TableCell>
                {/* v1.27.0 (B4): a pasted Application's requisition ID is synthetic; the cell renders empty. */}
                <TableCell className="font-mono text-[13px] [overflow-wrap:anywhere] whitespace-normal">{app.pastedDescription ? null : app.requisitionId}</TableCell>
                <TableCell>
                  {/* Stage and Override badges share one line in the table (design B5): never wrap, at least 207px. */}
                  <div className="flex min-w-[13.5rem] flex-nowrap gap-1.5">
                    <BoardStageBadge app={app} advanced={advanced} />
                    {app.override && <OverrideBadge />}
                    {app.pastedDescription && <PastedApplicationBadge />}
                  </div>
                </TableCell>
                <TableCell><time dateTime={app.createdAt}>{formatWatDate(app.createdAt)}</time></TableCell>
                <TableCell className="whitespace-nowrap tabular-nums"><ExpiresCell expiresOn={app.expiresOn} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y md:hidden" aria-label="Applications">
        {applications.map((app) => (
          <li key={app.id} className="flex items-start gap-3 py-3">
            <RowCheckbox app={app} checked={selection.isSelected(app.id)} onChange={(on) => selection.toggle(app.id, on)} />
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <Link to={`/applications/${app.id}`} className="font-medium [overflow-wrap:anywhere]">
                {applicationName(app)}
              </Link>
              {!app.pastedDescription && (
                <span className="font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{app.requisitionId}</span>
              )}
              <div className="flex flex-wrap gap-1.5">
                <BoardStageBadge app={app} advanced={advanced} />
                {app.override && <OverrideBadge />}
                {app.pastedDescription && <PastedApplicationBadge />}
              </div>
              <span className="text-muted-foreground">
                Created <time dateTime={app.createdAt}>{formatWatDate(app.createdAt)}</time>
                {app.expiresOn && (
                  <>
                    {" · "}
                    <time dateTime={app.expiresOn} className="tabular-nums">
                      {fillCopy(retentionCopy["applications.row.expires"], { date: formatWatDate(app.expiresOn) })}
                    </time>
                  </>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {pageCount > 1 && <PageControls page={page} pageCount={pageCount} onChange={changePage} />}
    </div>
  )
}

/** C-RET-14, or "—" with sr-only "No expiry date" (proposed C-RET-A3) when the date is missing. */
function ExpiresCell({ expiresOn }: { expiresOn: string | null | undefined }) {
  if (!expiresOn) {
    const none = retentionCopy["applications.row.expires.none"]
    return (
      <>
        <span aria-hidden="true">{none.visible}</span>
        <span className="sr-only">{none.srOnly}</span>
      </>
    )
  }
  return <time dateTime={expiresOn}>{fillCopy(retentionCopy["application.expiry.value"], { date: formatWatDate(expiresOn) })}</time>
}

function PageControls({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-end gap-2 text-sm">
      <Button variant="outline" size="sm" disabled={page === 1} onClick={() => onChange(page - 1)} aria-label="Previous page">
        <ChevronLeft aria-hidden="true" />
        Previous
      </Button>
      <span aria-live="polite" className="tabular-nums text-muted-foreground">
        Page {page} of {pageCount}
      </span>
      <Button variant="outline" size="sm" disabled={page === pageCount} onClick={() => onChange(page + 1)} aria-label="Next page">
        Next
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  )
}

function RowCheckbox({ app, checked, onChange }: { app: Application; checked: boolean; onChange: (on: boolean) => void }) {
  return <Checkbox aria-label={`Select ${applicationName(app)}, ${app.requisitionId}`} checked={checked} onCheckedChange={onChange} />
}
