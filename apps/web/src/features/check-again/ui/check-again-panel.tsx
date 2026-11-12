import { useEffect, useId, useLayoutEffect, useRef } from "react"
import { CircleX, TriangleAlert } from "lucide-react"

import { plural, relevanceCopy } from "@/entities/job-posting"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"

interface CheckAgainPanelProps {
  /** `recheckableCount`: visible failed plus visible not-checked postings, over all tabs. */
  count: number
  open: boolean
  alert: string | null
  isPending: boolean
  onOpen: () => void
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  /** The last press moved rows, so the panel is about to leave: closing focuses the active tab instead of "Check again". */
  movedRows: boolean
  /** The active tab trigger (design-spec.r1 Accessibility > Dialog, `finalFocus`). */
  activeTab: () => HTMLElement | null
}

/**
 * "Check again" (design-spec.r1 B5): a standing fact with an outline button,
 * between Add a job link and the tabs. Not a live region. The button name has
 * no count; the panel text describes it. Confirming names the count and the AI
 * spend; the confirm button is the filled default, since nothing is deleted.
 */
export function CheckAgainPanel({ count, open, alert, isPending, onOpen, onOpenChange, onConfirm, movedRows, activeTab }: CheckAgainPanelProps) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const latest = useRef({ movedRows, activeTab })
  useLayoutEffect(() => {
    latest.current = { movedRows, activeTab }
  })
  const leave = () => latest.current.activeTab()?.focus()
  // Layout cleanup runs before React removes the node, so the button can still be the focused element.
  useLayoutEffect(() => {
    const button = buttonRef.current
    return () => {
      // Fallback when the panel unmounts later with its button focused (for example after a nothing-new press).
      if (button !== null && document.activeElement === button) requestAnimationFrame(() => latest.current.activeTab()?.focus())
    }
  }, [])
  // After a refusal the dialog stays open: keep focus on the confirm button, which is the retry (DP-1).
  useEffect(() => {
    if (alert) confirmRef.current?.focus()
  }, [alert])
  const copy = relevanceCopy.postings.checkAgain
  return (
    <>
      <Alert role={undefined} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-text" />
          <AlertTitle id={`${id}-text`} className="font-normal tabular-nums">
            {plural(copy.panel.text, count)}
          </AlertTitle>
        </div>
        <Button ref={buttonRef} variant="outline" size="sm" className="w-full shrink-0 pointer-coarse:h-10 sm:w-auto" aria-describedby={`${id}-text`} onClick={onOpen}>
          {copy.panel.action}
        </Button>
      </Alert>
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title={plural(copy.dialog.title, count)}
        body={copy.dialog.body}
        confirmLabel={plural(copy.dialog.confirm, count)}
        pendingLabel={copy.dialog.pending}
        isPending={isPending}
        onConfirm={onConfirm}
        keepFocusWhilePending
        confirmRef={confirmRef}
        finalFocus={() => {
          if (!latest.current.movedRows) return buttonRef.current
          // The refetch will unmount the panel; go straight to the active tab (DP-2).
          requestAnimationFrame(leave)
          return false
        }}
        alert={
          alert && (
            <Alert variant="destructive" role="alert">
              <CircleX aria-hidden="true" />
              <AlertTitle className="font-normal [overflow-wrap:anywhere]">{alert}</AlertTitle>
            </Alert>
          )
        }
      />
    </>
  )
}
