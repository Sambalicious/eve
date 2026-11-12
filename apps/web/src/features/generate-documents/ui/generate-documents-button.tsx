import { useState } from "react"
import { Link } from "react-router-dom"

import { applicationCopy } from "@/entities/application"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { useGenerateDocuments } from "../model/use-generate-documents"

/**
 * C-DOC-13: "Generate documents" (loading "Starting…") on the first run,
 * "Generate again" after a failure or block. A missing name shows C-DOC-30
 * with the C-DOC-31 link to Settings > Contact details.
 */
export function GenerateDocumentsButton({ applicationId, isRetry }: { applicationId: string; isRetry: boolean }) {
  const [contactMissing, setContactMissing] = useState(false)
  const { generate, isStarting } = useGenerateDocuments(applicationId, { onContactMissing: () => setContactMissing(true) })
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        onClick={() => {
          setContactMissing(false)
          generate()
        }}
        aria-busy={isStarting}
        disabled={isStarting}
        variant={isRetry ? "outline" : "default"}
      >
        {isStarting && <ButtonSpinner />}
        {isStarting ? applicationCopy.starting : isRetry ? applicationCopy.generateAgain : applicationCopy.generate}
      </Button>
      {contactMissing && (
        <p role="alert" className="text-sm text-destructive-text">
          {applicationCopy.contactMissing}{" "}
          <Link to="/settings#contact" className="underline underline-offset-4">
            {applicationCopy.addContactDetails}
          </Link>
        </p>
      )}
    </div>
  )
}
