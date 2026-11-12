import { useEffect, useLayoutEffect, useRef } from "react"
import { CircleX, ListX } from "lucide-react"

import { overrideCopy } from "@/entities/application"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"

interface RemoveFromQueueProps {
  role: string | null
  company: string | null
  open: boolean
  inlineError: string | null
  isPending: boolean
  onOpen: () => void
  onClose: () => void
  onConfirm: () => void
}

const q = overrideCopy.queue

/**
 * B3 and B4: the outline "Remove from queue" (C-AA-23, named C-AA-24) under the
 * queued status line, and its non-destructive confirmation (C-AA-25 to C-AA-28).
 * Cancel returns focus to the button; after a request settles the button is
 * usually gone, so focus goes to the page heading (`finalFocus`).
 */
export function RemoveFromQueue({ role, company, open, inlineError, isPending, onOpen, onClose, onConfirm }: RemoveFromQueueProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const settled = useRef(false)
  useEffect(() => {
    if (inlineError) confirmRef.current?.focus()
  }, [inlineError])
  // Design "Real-time": when a poll or a refetch removes the button while it has focus, focus the page heading.
  useLayoutEffect(() => {
    const button = buttonRef.current
    return () => {
      if (button !== null && document.activeElement === button) requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus())
    }
  }, [])
  // True once a request was sent from this opening of the dialog.
  useEffect(() => {
    if (isPending) settled.current = true
  }, [isPending])
  return (
    <div>
      <Button
        ref={buttonRef}
        variant="outline"
        className="w-full sm:w-auto"
        onClick={() => {
          settled.current = false
          onOpen()
        }} aria-label={role && company ? q.removeFor(role, company) : undefined}>
        {isPending ? <ButtonSpinner /> : <ListX aria-hidden="true" />}
        {q.remove}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title={q.dialogTitle}
        body={q.dialogBody}
        confirmLabel={q.confirm}
        pendingLabel={q.pending}
        isPending={isPending}
        onConfirm={onConfirm}
        keepFocusWhilePending
        confirmRef={confirmRef}
        finalFocus={() => {
          // A request was sent: the button leaves with the queued state, so the page heading takes focus.
          if (settled.current) {
            settled.current = false
            return document.querySelector<HTMLElement>("main h1") ?? false
          }
          return buttonRef.current
        }}
        alert={
          inlineError && (
            <Alert variant="destructive" role="alert">
              <CircleX aria-hidden="true" />
              <AlertTitle className="font-normal [overflow-wrap:anywhere]">{inlineError}</AlertTitle>
            </Alert>
          )
        }
      />
    </div>
  )
}
