import { careerProfileCopy } from "@/entities/career-profile"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { useDiscardDraft } from "../model/use-edit-career-profile"

/**
 * "Discard draft" with C-CONFIRM-17 (destructive). The outline button sits in
 * a later draft's actions; the link appearance is C-PROFILE-17's action, which
 * also offers it on a first draft (QA-2B-03).
 */
export function DiscardDraftButton({ version, appearance = "button" }: { version: number; appearance?: "button" | "link" }) {
  const { isConfirming, setIsConfirming, discard, isDiscarding } = useDiscardDraft(version)
  const copy = careerProfileCopy.confirmDiscard(version)
  return (
    <>
      <Button
        variant={appearance === "link" ? "link" : "outline"}
        className={appearance === "link" ? "h-auto p-0" : undefined}
        onClick={() => setIsConfirming(true)}
      >
        {careerProfileCopy.discardDraft}
      </Button>
      <ConfirmDialog
        open={isConfirming}
        onOpenChange={setIsConfirming}
        title={copy.title}
        body={copy.body}
        confirmLabel={copy.confirm}
        pendingLabel="Deleting…"
        isPending={isDiscarding}
        destructive
        onConfirm={discard}
      />
    </>
  )
}
