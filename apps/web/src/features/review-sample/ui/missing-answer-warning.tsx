import { CircleAlert } from "lucide-react"
import { Link } from "react-router-dom"

import { submissionCopy } from "@/entities/application"
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { firstMissingAnswer } from "../model/form-answer-lines"
import { useFormAnswers } from "../model/use-form-answers"

/**
 * C-SAMPLE-8 above the action bar: a required question has no Approved Answer,
 * so approving would block it. CR5E-01: for a manual-only question no Approved
 * Answer can help, so "Add Approved Answer" is not offered.
 * OPEN[designer]: no manual-path line for a manual-only question; the warning shows C-SAMPLE-8 alone.
 */
export function MissingAnswerWarning({ applicationId }: { applicationId: string }) {
  const { data } = useFormAnswers(applicationId)
  const missing = data ? firstMissingAnswer(data.answers) : null
  if (!missing) return null
  return (
    <Alert role="note" className="border-warning/40 *:[svg]:text-warning-text">
      <CircleAlert aria-hidden="true" />
      <AlertTitle className="font-normal text-pretty [overflow-wrap:anywhere]">{submissionCopy.sample.missingAnswerWarning(missing.question)}</AlertTitle>
      {!missing.manualOnly && (
        <AlertDescription>
          <Link to="/answers" className="text-foreground underline underline-offset-4">
            {submissionCopy.blocked.addAnswer}
          </Link>
        </AlertDescription>
      )}
    </Alert>
  )
}
