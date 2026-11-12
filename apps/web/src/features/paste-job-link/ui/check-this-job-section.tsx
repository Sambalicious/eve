import { useId, useState } from "react"

import { hiringCopy as h } from "@/entities/stack-post"
import { Button } from "@/shared/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/dialog"
import { Section } from "@/shared/ui/section"
import { PasteJobLinkForm } from "./paste-job-link-form"

export const CHECK_THIS_JOB_SECTION_ID = "check-this-job"

/**
 * Check this job (EPIC-0007 design-spec r1 B2, H4, H5; EPIC-0011 owner decision
 * 2026-11-09): the section keeps its heading and one help line, and its form now
 * opens in a dialog from one button instead of sitting inline. `hintShown` is true
 * only while the Hiring search links note C-HP-HINT is on screen (Phase 1); until
 * then, and in every other state, the help is C-HP-CHECK-HELP-SOLO.
 */
export function CheckThisJobSection({
  hintShown = false,
}: {
  hintShown?: boolean
}) {
  const helpId = useId()
  const [open, setOpen] = useState(false)
  return (
    <Section
      id={CHECK_THIS_JOB_SECTION_ID}
      title={h.checkTitle}
      description={
        <p id={helpId}>{hintShown ? h.checkHelp : h.checkHelpSolo}</p>
      }
      headingProps={{ tabIndex: -1 }}
    >
      <Button onClick={() => setOpen(true)}>{h.checkOpen}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{h.checkTitle}</DialogTitle>
          </DialogHeader>
          <PasteJobLinkForm
            kind="check"
            label={h.checkUrlLabel}
            describedBy={helpId}
          />
        </DialogContent>
      </Dialog>
    </Section>
  )
}
