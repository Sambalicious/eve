import { CircleAlert } from "lucide-react"
import { Link } from "react-router-dom"

import type { ResumeProblem } from "../model/resume-problem"

/**
 * Inline refusal or failure under the drop zone (design-spec.r3 component
 * "Resume drop zone"): destructive text with `CircleAlert`, `role="alert"`,
 * then the muted detail line and the optional link.
 */
export function ResumeProblemAlert({ id, problem }: { id?: string; problem: ResumeProblem }) {
  return (
    <div id={id} role="alert" className="flex items-start gap-2 text-sm">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive-text" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-destructive-text [overflow-wrap:anywhere]">{problem.message}</p>
        {problem.detail && <p className="text-muted-foreground">{problem.detail}</p>}
        {problem.link && (
          <Link to={problem.link.to} className="w-fit underline underline-offset-4 hover:text-foreground">
            {problem.link.label}
          </Link>
        )}
      </div>
    </div>
  )
}
