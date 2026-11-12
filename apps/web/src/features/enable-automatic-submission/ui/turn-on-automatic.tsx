import { useEffect, useRef } from "react"
import { CircleAlert } from "lucide-react"

import { submissionCopy, type SubmissionStatus } from "@/entities/application"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { useEnableAutomatic } from "../model/use-enable-automatic"

const g = submissionCopy.gate

/** "Turn on automatic submission", or "Automatic submission is on" once enabled. */
export function TurnOnAutomatic({ status }: { status: SubmissionStatus }) {
  const enable = useEnableAutomatic(status)
  const refusalRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (enable.refusal) refusalRef.current?.focus()
  }, [enable.refusal])
  if (status.automaticEnabled) return <p className="text-sm font-medium">{g.isOn}</p>
  const isReady = status.gatePassedAt !== null
  return (
    <div className="flex flex-col items-start gap-2">
      <Button aria-disabled={isReady ? undefined : "true"} className="aria-disabled:opacity-50" onClick={enable.activate}>
        {g.turnOn}
      </Button>
      {enable.refusal && (
        <p ref={refusalRef} tabIndex={-1} role="alert" className="flex items-start gap-1.5 text-sm text-destructive-text outline-none">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {enable.refusal}
        </p>
      )}
      <ConfirmDialog
        open={enable.confirming}
        onOpenChange={enable.setConfirming}
        title={g.confirmOn.title}
        body={g.confirmOn.body}
        confirmLabel={g.confirmOn.confirm}
        pendingLabel="Turning on…"
        isPending={enable.isPending}
        onConfirm={enable.confirm}
      />
    </div>
  )
}
