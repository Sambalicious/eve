import { Link } from "react-router-dom"

import { uploadCopy } from "@/entities/career-profile"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { useConsent } from "../model/use-consent"

/**
 * The AI-provider consent as one line on the Upload screen (R2, AC-2.2, AC-2.2a). The line, not a
 * control that can fail, is chosen by role: the Operator without approval gets an "Approve" button;
 * everyone else gets a statement and the terms link, never a control that would answer 403.
 */
export function ConsentLine({ onApproved }: { onApproved?: () => void }) {
  const { ready, approved, isOperator, isApproving, approve } = useConsent(onApproved)
  if (!ready) return null
  const termsLink = (
    <Link to="/privacy#ai-provider" className="underline underline-offset-4">
      {uploadCopy.consentLink}
    </Link>
  )
  if (approved) {
    return (
      <p className="text-sm text-muted-foreground">
        {uploadCopy.consentApproved} {termsLink}
      </p>
    )
  }
  if (!isOperator) {
    return (
      <p className="text-sm text-muted-foreground">
        {uploadCopy.consentPending} {termsLink}
      </p>
    )
  }
  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="max-w-[60ch] text-sm">
        {uploadCopy.consentLine} {termsLink}
      </p>
      <Button
        variant="outline"
        size="sm"
        aria-busy={isApproving}
        disabled={isApproving}
        onClick={approve}
      >
        {isApproving && <ButtonSpinner />}
        {isApproving ? uploadCopy.consentApproving : uploadCopy.consentApprove}
      </Button>
    </div>
  )
}
