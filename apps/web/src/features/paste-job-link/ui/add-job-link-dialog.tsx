import { useEffect, useCallback, useId, useRef, useState } from "react"
import { Link2 } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/shared/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog"
import { addJobLinkCopy } from "../model/add-job-link-copy"
import { PasteJobLinkForm } from "./paste-job-link-form"

/**
 * "Add a job link" on `/postings` (EPIC-0011): one outline button on its own row
 * opens the form in a dialog, so the page's first block is a row rather than a
 * full-width section.
 *
 * - Outline, not primary: "Check link" inside stays the page's only filled button.
 * - The button is full width below `sm` and content width from `sm` up, where it
 *   lines up with the page column's start.
 * - A request in flight keeps the dialog open (Esc, the overlay and the close
 *   button do nothing until it settles), as `RaiseCeiling` does.
 * - The popup is capped at the viewport height minus the 2rem gutters and the
 *   body scrolls, as `VerifyAlertSourceDialog` does, so the title and the link
 *   field stay in view with the description panel open at 375 and a keyboard.
 * - The header is pinned above that scroll, with a hairline under it
 *   (`border-b border-border`), so where the body is cut is a visible edge and
 *   not a line of help text sliced in half. `pb-3` keeps the rule off the title
 *   so it reads as a divider rather than an underline. The body keeps `-mx-6
 *   px-6`, so the rule and the body's content share the same width.
 */
export function AddJobLinkDialog({ className }: { className?: string }) {
  const helpId = useId()
  const [open, setOpen] = useState(false)
  const [isPending, setIsPending] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const onSaved = useCallback(() => setOpen(false), [])
  const onPendingChange = useCallback((isPasting: boolean) => setIsPending(isPasting), [])
  // Every close path returns focus to the trigger: Esc, the overlay, Close, and a saved
  // posting. The primitive skips its own return on an outside press, so this is explicit.
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    triggerRef.current?.focus()
  }, [open])
  return (
    <Dialog open={open} onOpenChange={setOpen} dismissDisabled={isPending}>
      <DialogTrigger
        render={<Button ref={triggerRef} variant="outline" />}
        className={cn("w-full sm:w-auto sm:self-start", className)}
      >
        <Link2 aria-hidden="true" />
        {addJobLinkCopy.title}
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader className="flex-none border-b border-border pb-3">
          <DialogTitle>{addJobLinkCopy.title}</DialogTitle>
        </DialogHeader>
        <div
          data-slot="add-job-link-body"
          className="-mx-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-6 py-1"
        >
          <DialogDescription id={helpId}>{addJobLinkCopy.help}</DialogDescription>
          <PasteJobLinkForm
            kind="add"
            label={addJobLinkCopy.label}
            dialog={{ onSaved, onPendingChange, describedBy: helpId }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
