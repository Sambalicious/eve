import { Info } from "lucide-react"
import { Link } from "react-router-dom"

import { submissionCopy } from "@/entities/application"
import { jobPostingCopy } from "@/entities/job-posting"
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"

const copy = submissionCopy.sample.criteriaNote

interface Props {
  /** For "Approve and submit"'s `aria-describedby`. */
  id: string
  /** The skip line from `criteriaNoteReason()`. */
  reason: string
}

/**
 * g9 (O6, AC 5.8): the sample's posting no longer meets the job criteria.
 * Informational only: approving still works. `role="note"`, not a live region,
 * so a refetch that adds it announces nothing and moves no focus.
 */
export function SampleCriteriaNote({ id, reason }: Props) {
  return (
    <Alert role="note" id={id} aria-labelledby={`${id}-title`}>
      <Info aria-hidden="true" />
      <AlertTitle id={`${id}-title`} className="text-pretty [overflow-wrap:anywhere]">
        {copy.title}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-0.5 [&_p:not(:last-child)]:mb-0">
        <p className="text-pretty [overflow-wrap:anywhere]">{reason}</p>
        <p className="text-pretty [overflow-wrap:anywhere]">{copy.body}</p>
        {/* Below 768px the action bar sticks to the bottom; the margin keeps a focused link clear of it (check 14). */}
        <Link to={jobPostingCopy.criteria.settingsHref} className="scroll-mb-20 text-foreground underline underline-offset-4 md:scroll-mb-0">
          {jobPostingCopy.criteria.change}
        </Link>
      </AlertDescription>
    </Alert>
  )
}
