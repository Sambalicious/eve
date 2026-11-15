import { useCallback, useId, useState } from "react"

import { hiringCopy as h } from "@/entities/stack-post"
import { Button } from "@/shared/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog"
import { Section } from "@/shared/ui/section"
import { PasteJobLinkForm } from "./paste-job-link-form"

export const CHECK_THIS_JOB_SECTION_ID = "check-this-job"

/**
 * Check this job (EPIC-0007 design-spec r1 B2, H4, H5; EPIC-0011 owner decision
 * 2026-11-09): the section keeps its heading and one help line, and its form now
 * opens in a dialog from one button instead of sitting inline. `hintShown` is true
 * only while the Hiring search links note C-HP-HINT is on screen (Phase 1); until
 * then, and in every other state, the help is C-HP-CHECK-HELP-SOLO.
 *
 * The help line is also the dialog's `DialogDescription`, in its pinned header, so
 * a sighted Candidate reads it while the form is open: the section copy sits
 * behind the scrim. The link field's `aria-describedby` points at that in-dialog
 * description and at nothing outside the popup, so the accessible description is
 * the text on screen.
 *
 * That pinned header carries a hairline under it (`border-b border-border`): the
 * body below it scrolls, and at 375x420 the help would otherwise be cut in half
 * with nothing marking it as the edge. `pb-3` keeps the rule off the last line so
 * it reads as a divider and not as an underline on the help. The body keeps
 * `-mx-6 px-6`, so the rule and the body's content share the same width.
 */
export function CheckThisJobSection({
  hintShown = false,
}: {
  hintShown?: boolean
}) {
  const help = hintShown ? h.checkHelp : h.checkHelpSolo
  const helpId = useId()
  const [open, setOpen] = useState(false)
  const [isPending, setIsPending] = useState(false)
  const onPendingChange = useCallback(
    (isPasting: boolean) => setIsPending(isPasting),
    []
  )
  return (
    <Section
      id={CHECK_THIS_JOB_SECTION_ID}
      title={h.checkTitle}
      description={<p>{help}</p>}
      headingProps={{ tabIndex: -1 }}
    >
      <Button onClick={() => setOpen(true)}>{h.checkOpen}</Button>
      <Dialog open={open} onOpenChange={setOpen} dismissDisabled={isPending}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-md">
          <DialogHeader className="flex-none border-b border-border pb-3">
            <DialogTitle>{h.checkTitle}</DialogTitle>
            <DialogDescription id={helpId} className="text-pretty">
              {help}
            </DialogDescription>
          </DialogHeader>
          <div
            data-slot="check-this-job-body"
            className="-mx-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-6 py-1"
          >
            <PasteJobLinkForm
              kind="check"
              label={h.checkUrlLabel}
              describedBy={helpId}
              dialog={{ onPendingChange }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  )
}
