import { useState } from "react"
import { Ellipsis, Trash2 } from "lucide-react"

import { recordCopy } from "@/entities/requisition-record"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu"
import { useDeleteDetailedRecords } from "../model/use-delete-detailed-records"

/**
 * The Application detail's overflow menu with "Delete detailed records"
 * (F10 retention step 1), confirmed by C-CONFIRM-11.
 */
export function DeleteRecordsMenu({ applicationId, role, company }: { applicationId: string; role: string; company: string }) {
  const [confirming, setConfirming] = useState(false)
  const { remove, isDeleting } = useDeleteDetailedRecords({ onDone: () => setConfirming(false) })
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label={recordCopy.moreActions} />}>
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" />
            {recordCopy.deleteDetails}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={recordCopy.confirmOne.title}
        body={recordCopy.confirmOne.body(role, company)}
        confirmLabel={recordCopy.confirmOne.confirm}
        pendingLabel={recordCopy.deleting}
        isPending={isDeleting}
        destructive
        onConfirm={() => remove([applicationId])}
      />
    </>
  )
}

/**
 * Bulk toolbar action "Delete detailed records ({n})" (F10 retention step 2),
 * confirmed by C-CONFIRM-12. `onDeleted` clears the selection.
 */
export function DeleteSelectedRecords({ applicationIds, onDeleted }: { applicationIds: readonly string[]; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const { remove, isDeleting } = useDeleteDetailedRecords({
    onDone: () => {
      setConfirming(false)
      onDeleted()
    },
  })
  const n = applicationIds.length
  return (
    <>
      <Button variant="destructive" size="sm" disabled={n === 0} onClick={() => setConfirming(true)}>
        <Trash2 aria-hidden="true" />
        {recordCopy.deleteDetailsCount(n)}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={recordCopy.confirmBulk.title(n)}
        body={recordCopy.confirmBulk.body}
        confirmLabel={recordCopy.confirmBulk.confirm}
        pendingLabel={recordCopy.deleting}
        isPending={isDeleting}
        destructive
        onConfirm={() => remove(applicationIds)}
      />
    </>
  )
}
