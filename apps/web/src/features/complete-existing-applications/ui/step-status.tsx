import { useRef, useState } from "react"
import { CircleCheck } from "lucide-react"

import { existingApplicationCopy as c } from "@/entities/existing-application"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { useCompleteExistingApplications } from "../model/use-complete-existing-applications"

/**
 * The step status at the top of `/existing-applications` (F1 step 6a.1).
 * Incomplete: C-EXIST-8 and "Mark this step complete", which confirms with
 * C-CONFIRM-2. Complete: C-EXIST-2 with a check and no button, because the
 * step completes once. The line is a polite live region, and focus moves to it
 * when the dialog closes on success, since the button that opened it is gone.
 */
export function StepStatus({ completedAt }: { completedAt: string | null }) {
  const [confirming, setConfirming] = useState(false)
  const doneRef = useRef<HTMLParagraphElement>(null)
  const { complete, isCompleting } = useCompleteExistingApplications({
    onCompleted: () => setConfirming(false),
  })

  return (
    <div className="flex flex-col items-start gap-x-6 gap-y-3 border-b pb-6 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div role="status" className="w-full min-w-0 sm:w-auto sm:flex-1">
        {completedAt ? (
          <p
            ref={doneRef}
            tabIndex={-1}
            className="flex items-start gap-2 text-sm outline-none"
          >
            <CircleCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-success-text"
            />
            {c.completedOn(completedAt)}
          </p>
        ) : (
          <p className="max-w-[60ch] text-sm">{c.notComplete}</p>
        )}
      </div>
      {!completedAt && (
        <Button onClick={() => setConfirming(true)}>{c.markComplete}</Button>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={c.confirm.title}
        body={c.confirm.body}
        confirmLabel={c.confirm.confirm}
        pendingLabel={c.confirm.pending}
        isPending={isCompleting}
        onConfirm={complete}
        finalFocus={() => doneRef.current ?? true}
      />
    </div>
  )
}
