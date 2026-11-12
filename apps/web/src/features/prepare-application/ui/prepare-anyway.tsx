import { useEffect, useRef } from "react"
import { CalendarClock, CircleX, FileText, ShieldCheck, TriangleAlert } from "lucide-react"

import { applicationCopy, overrideCopy } from "@/entities/application"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import type { OverrideSnapshot } from "../model/use-prepare-anyway"

interface PrepareAnywayProps {
  /** v1.28.0 manual lane: nothing is overridden; Eve prepares documents for a job the Candidate applies to by hand. */
  manual?: boolean
  role: string | null
  company: string | null
  cap: number | null
  snapshot: OverrideSnapshot | null
  inlineError: string | null
  isPending: boolean
  onOpen: () => void
  onClose: () => void
  onConfirm: () => void
  /** True after a refusal: focus goes to the page heading because the button may be gone. */
  shouldFocusHeading: () => boolean
}

/**
 * B1 and B2: the outline "Prepare documents anyway" (C-AA-1, named C-AA-2) and
 * its consent dialog. The dialog quotes the reason line it opened with and the
 * two statements (C-AA-4 to C-AA-6). Nothing is sent until Confirm (C-AA-7).
 * A network failure stays in the dialog with C-ERR-2 and focus on Confirm.
 */
export function PrepareAnyway({ manual = false, role, company, cap, snapshot, inlineError, isPending, onOpen, onClose, onConfirm, shouldFocusHeading }: PrepareAnywayProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (inlineError) confirmRef.current?.focus()
  }, [inlineError])
  return (
    <>
      <Button
        ref={buttonRef}
        variant="outline"
        className="w-full sm:w-auto"
        onClick={onOpen}
        aria-busy={isPending}
        aria-label={role && company ? applicationCopy.prepareAnywayFor(role, company) : undefined}
      >
        {isPending ? <ButtonSpinner /> : <FileText aria-hidden="true" />}
        {manual ? overrideCopy.manualActionLabel : applicationCopy.prepareAnyway}
      </Button>
      <ConfirmDialog
        open={snapshot !== null}
        onOpenChange={(open) => !open && onClose()}
        title={manual ? overrideCopy.manualDialogTitle : overrideCopy.dialogTitle}
        body=""
        confirmLabel={manual ? overrideCopy.manualConfirm : overrideCopy.confirm}
        pendingLabel={overrideCopy.pending}
        isPending={isPending}
        onConfirm={onConfirm}
        keepFocusWhilePending
        confirmRef={confirmRef}
        wide
        finalFocus={() => (shouldFocusHeading() ? (document.querySelector<HTMLElement>("main h1") ?? false) : buttonRef.current)}
        alert={
          inlineError && (
            <Alert variant="destructive" role="alert">
              <CircleX aria-hidden="true" />
              <AlertTitle className="font-normal [overflow-wrap:anywhere]">{inlineError}</AlertTitle>
            </Alert>
          )
        }
      >
        {snapshot && (
          <>
            <div className="flex flex-col gap-1.5">
              <p>{manual ? overrideCopy.manualReasonLead : overrideCopy.reasonLead}</p>
              <blockquote className="border-l-2 border-primary/30 pl-3 [overflow-wrap:anywhere]">{snapshot.reasonLine}</blockquote>
            </div>
            {manual ? (
              <p className="text-pretty">{overrideCopy.manualBound}</p>
            ) : (
              <>
                <p className="flex items-start gap-2 text-pretty">
                  <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{overrideCopy.autoSend(cap)}</span>
                </p>
                <p className="flex items-start gap-2 text-pretty">
                  <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{overrideCopy.bound}</span>
                </p>
              </>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  )
}

/** B1 refusal panel: the 409 message, title only, announced (`role="alert"`). Replaced, never stacked. */
export function AnywayRefusalPanel({ message }: { message: string }) {
  return (
    <Alert role="alert">
      <TriangleAlert aria-hidden="true" className="text-warning-text!" />
      <AlertTitle className="font-normal [overflow-wrap:anywhere]">{message}</AlertTitle>
    </Alert>
  )
}
