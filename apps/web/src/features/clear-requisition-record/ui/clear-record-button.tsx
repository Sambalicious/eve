import { useState } from "react"

import { recordCopy } from "@/entities/requisition-record"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { useClearRecord } from "../model/use-clear-record"

interface ClearRecordButtonProps {
  applicationId: string
  requisitionId: string
  company: string
  /** "Clear" in the `/privacy` table, "Clear record" on the minimal record view. */
  label: string
  /** Accessible name when the visible label is short ("Clear" in a table row). */
  ariaLabel?: string
  onCleared?: () => void
}

/** "Clear" / "Clear record" with C-CONFIRM-13. */
export function ClearRecordButton({ applicationId, requisitionId, company, label, ariaLabel, onCleared }: ClearRecordButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const { clear, isClearing } = useClearRecord({
    onCleared: () => {
      setConfirming(false)
      onCleared?.()
    },
  })
  return (
    <>
      <Button variant="outline" size="sm" aria-label={ariaLabel} onClick={() => setConfirming(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={recordCopy.confirmClear.title}
        body={recordCopy.confirmClear.body(requisitionId, company)}
        confirmLabel={recordCopy.confirmClear.confirm}
        pendingLabel={recordCopy.clearing}
        isPending={isClearing}
        destructive
        onConfirm={() => clear(applicationId)}
      />
    </>
  )
}
