import { CircleX, ClipboardPaste, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { Badge } from "@/shared/ui/badge"

import { jobPostingCopy } from "../model/copy"
import { pastedPostingCopy } from "../model/pasted-copy"
import type { PastedWarning } from "../model/pasted-warning"

/** C-PD-40: the quiet outline "Pasted" mark on a pasted-description posting (design B2, B4). */
export function PastedDescriptionBadge() {
  return (
    <Badge variant="outline">
      <ClipboardPaste aria-hidden="true" />
      {pastedPostingCopy.badge}
    </Badge>
  )
}

/**
 * PD-4.3 warning panel (design B2, B3): C-PD-42 title, the violated rules after
 * C-PD-44 (excluded) or the reason line (skipped), then `body` (C-PD-43 on the
 * posting, C-PD-63 on the Application). Static: no `role="alert"` on page load.
 */
export function PastedWarningPanel({ warning, body, titleId }: { warning: PastedWarning; body: string | null; titleId?: string }) {
  const excluded = warning.tone === "excluded"
  return (
    <Alert role={undefined} variant={excluded ? "destructive" : "default"} className={excluded ? undefined : "*:[svg]:text-warning-text"}>
      {excluded ? <CircleX aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      <AlertTitle id={titleId} className="[overflow-wrap:anywhere]">
        {pastedPostingCopy.warningTitle}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-1.5 [overflow-wrap:anywhere]">
        {"rules" in warning ? (
          <div>
            <p id={titleId && `${titleId}-lead`}>{pastedPostingCopy.rulesLead}</p>
            <ul aria-labelledby={titleId && `${titleId}-lead`} className="flex list-disc flex-wrap gap-x-6 pl-5">
              {warning.rules.map((rule) => (
                <li key={rule}>{jobPostingCopy.ruleLabel[rule]}</li>
              ))}
            </ul>
          </div>
        ) : (
          warning.reason && <p>{warning.reason}</p>
        )}
        {body && <p>{body}</p>}
      </AlertDescription>
    </Alert>
  )
}
