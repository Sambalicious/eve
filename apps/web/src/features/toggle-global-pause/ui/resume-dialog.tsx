import { automationCopy } from "@/entities/automation-state"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"

const c = automationCopy.pause.confirmResume

/** C-CONFIRM-10. Cancel keeps automation paused. */
export function ResumeDialog({
  open,
  onOpenChange,
  isPending,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  isPending: boolean
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={c.title}
      body={c.body}
      confirmLabel={c.confirm}
      pendingLabel="Resuming…"
      isPending={isPending}
      onConfirm={onConfirm}
    />
  )
}
