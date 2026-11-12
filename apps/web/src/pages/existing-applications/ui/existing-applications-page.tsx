import { useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ClipboardList } from "lucide-react"

import { AppShell } from "@/components/app-shell"
import { ExistingApplicationsSkeleton } from "@/components/page-skeletons"
import {
  existingApplicationCopy as c,
  existingApplicationsQueryOptions,
} from "@/entities/existing-application"
import { ExistingApplicationForm } from "@/features/add-existing-application"
import { StepStatus } from "@/features/complete-existing-applications"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Button } from "@/shared/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/dialog"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { QuietEmpty } from "@/shared/ui/section"
import { useRowHighlight } from "../model/use-row-highlight"
import {
  ExistingApplicationsTable,
  ROW_ATTRIBUTE,
} from "./existing-applications-table"

/**
 * Existing applications (`/existing-applications`, F1 step 6a). Reading order:
 * the step status, the "Add existing application" button (it opens the form in
 * a dialog at every width), then the table or C-EXIST-1.
 */
export function ExistingApplicationsPage() {
  useDocumentTitle(c.pageTitle)
  const list = useQuery(existingApplicationsQueryOptions())
  const [dialogOpen, setDialogOpen] = useState(false)
  const { highlightedId, highlight } = useRowHighlight(ROW_ATTRIBUTE)

  // "View it" from the dialog: the row is under it, so the dialog closes and hands focus to the row.
  const focusAfterDialog = useRef<HTMLElement | null>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const viewIt = (id: string) => {
    focusAfterDialog.current = highlight(id)
    if (dialogOpen) setDialogOpen(false)
  }
  const openDialog = () => {
    focusAfterDialog.current = null
    setDialogOpen(true)
  }

  return (
    <AppShell title={c.pageTitle} description={c.pageDescription}>
      <div className="flex w-full max-w-[1120px] flex-col gap-7 px-4 lg:px-6">
        {list.isError ? (
          <LoadErrorAlert onRetry={() => void list.refetch()} />
        ) : list.data ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <StepStatus completedAt={list.data.completedAt} />
              <Button ref={openButtonRef} variant="outline" onClick={openDialog}>
                {c.addButton}
              </Button>
            </div>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogContent
                className="max-h-[90dvh] max-w-xl overflow-y-auto"
                finalFocus={() =>
                  focusAfterDialog.current ?? openButtonRef.current ?? true
                }
              >
                <DialogHeader>
                  <DialogTitle>{c.addHeading}</DialogTitle>
                </DialogHeader>
                <ExistingApplicationForm
                  layout="stacked"
                  onAdded={() => setDialogOpen(false)}
                  onViewIt={viewIt}
                  primary={list.data.completedAt !== null}
                />
              </DialogContent>
            </Dialog>
            {list.data.applications.length === 0 ? (
              <QuietEmpty
                icon={<ClipboardList />}
                title={c.empty.title}
                description={c.empty.text}
              />
            ) : (
              <ExistingApplicationsTable
                applications={list.data.applications}
                highlightedId={highlightedId}
              />
            )}
          </>
        ) : (
          <ExistingApplicationsSkeleton />
        )}
      </div>
    </AppShell>
  )
}
