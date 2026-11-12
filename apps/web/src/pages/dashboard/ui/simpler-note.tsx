import { Info } from "lucide-react"

import { homeCopy } from "@/entities/job-posting"
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { useDismissSimplerNote } from "../model/use-dismiss-simpler"

/** "Eve is simpler now" (AC-7.3): shown once to an existing account with Advanced off, then dismissed on the server. */
export function SimplerNote() {
  const { dismiss, isPending } = useDismissSimplerNote()
  return (
    <Alert role="note">
      <Info aria-hidden="true" />
      <AlertTitle>{homeCopy.simplerNote.title}</AlertTitle>
      <AlertDescription>{homeCopy.simplerNote.body}</AlertDescription>
      <div className="col-start-2 mt-2">
        <Button variant="outline" size="sm" disabled={isPending} onClick={dismiss}>
          {homeCopy.simplerNote.dismiss}
        </Button>
      </div>
    </Alert>
  )
}
