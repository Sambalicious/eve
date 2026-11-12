import { approvedAnswerCopy, type ApprovedAnswer } from "@/entities/approved-answer"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { useDeleteApprovedAnswer } from "../model/use-manage-approved-answer"

/** C-CONFIRM-14 for one answer. */
export function DeleteAnswerDialog({ answer, onClose }: { answer: ApprovedAnswer | null; onClose: () => void }) {
  const { remove, isDeleting } = useDeleteApprovedAnswer({ onDeleted: onClose })
  return (
    <ConfirmDialog
      open={answer !== null}
      onOpenChange={(open) => !open && onClose()}
      title={approvedAnswerCopy.confirmDelete.title}
      body={approvedAnswerCopy.confirmDelete.body}
      confirmLabel={approvedAnswerCopy.confirmDelete.confirm}
      pendingLabel="Deleting…"
      isPending={isDeleting}
      destructive
      onConfirm={() => answer && remove(answer.id)}
    />
  )
}
