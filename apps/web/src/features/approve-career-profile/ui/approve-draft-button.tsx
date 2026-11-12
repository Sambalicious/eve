import { careerProfileCopy, type ProfileVersion } from "@/entities/career-profile"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"

interface ApproveDraftButtonProps {
  draft: ProfileVersion
  onRequestApproval: () => void
  isConfirming: boolean
  onConfirmingChange: (open: boolean) => void
  onConfirm: () => void
  isApproving: boolean
}

/** "Approve Career Profile" (version 1, C-CONFIRM-1) or "Approve version {n}" (C-CONFIRM-16). */
export function ApproveDraftButton({
  draft,
  onRequestApproval,
  isConfirming,
  onConfirmingChange,
  onConfirm,
  isApproving,
}: ApproveDraftButtonProps) {
  const isFirst = draft.version === 1
  const confirmCopy = isFirst
    ? careerProfileCopy.confirmApproveFirst
    : careerProfileCopy.confirmApproveVersion(draft.version)
  return (
    <>
      <Button onClick={onRequestApproval}>
        {isFirst ? careerProfileCopy.approveProfile : careerProfileCopy.approveVersion(draft.version)}
      </Button>
      <ConfirmDialog
        open={isConfirming}
        onOpenChange={onConfirmingChange}
        title={confirmCopy.title}
        body={confirmCopy.body}
        confirmLabel={confirmCopy.confirm}
        pendingLabel="Approving…"
        isPending={isApproving}
        onConfirm={onConfirm}
      />
    </>
  )
}
