import { MailWarning } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { notificationCopy } from "../model/copy"
import type { AccessRequestCounts } from "../model/notification"

const c = notificationCopy.accessRequests

/**
 * Home alert for unsent access requests (EPIC-0003 AC 11.16, OQ7; copy-deck r2
 * `dashboard.access_requests.*`). Counts only. When both states apply only
 * "waiting" shows, because fixing the setup is the first step. Same warning
 * look and `role="status"` as C-NOTIFY-1: a found state, never an interruption.
 */
export function AccessRequestAlert({ counts }: { counts: AccessRequestCounts }) {
  const waiting = counts.waiting > 0
  if (!waiting && counts.failed <= 0) return null
  return (
    <Alert role="status" className="border-warning/40 *:[svg]:text-warning-text">
      <MailWarning aria-hidden="true" />
      <AlertTitle>{waiting ? c.titleWaiting : c.titleFailed}</AlertTitle>
      <AlertDescription className="text-pretty">{waiting ? c.textWaiting(counts.waiting) : c.textFailed(counts.failed)}</AlertDescription>
    </Alert>
  )
}
