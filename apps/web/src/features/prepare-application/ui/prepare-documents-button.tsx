import { FileText } from "lucide-react"

import { applicationCopy } from "@/entities/application"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { usePrepareApplication } from "../model/use-prepare-application"

/**
 * C-DOC-11: "Prepare documents" on a ranked posting with no Application, named
 * "Prepare documents for {role} at {company}" when both are known. The
 * overridable-posting variant is `PrepareAnyway`, which asks for consent first.
 */
export function PrepareDocumentsButton({
  jobPostingId,
  role,
  company,
  describedBy,
}: {
  jobPostingId: string
  role: string | null
  company: string | null
  /** EPIC-0010 design B2: the pasted-job warning title, read with the button. */
  describedBy?: string
}) {
  const { prepare, isPreparing } = usePrepareApplication()
  return (
    <Button
      className="w-full sm:w-auto"
      onClick={() => prepare(jobPostingId)}
      aria-busy={isPreparing}
      disabled={isPreparing}
      aria-label={role && company ? applicationCopy.prepareFor(role, company) : undefined}
      aria-describedby={describedBy}
    >
      {isPreparing ? <ButtonSpinner /> : <FileText aria-hidden="true" />}
      {applicationCopy.prepare}
    </Button>
  )
}
