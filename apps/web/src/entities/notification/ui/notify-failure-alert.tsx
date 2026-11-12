import { MailWarning } from "lucide-react"
import { Link } from "react-router-dom"

import { formatWatDateTime } from "@/shared/lib/format-wat"
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { notificationCopy } from "../model/copy"
import type { NotificationFailure } from "../model/notification"

const c = notificationCopy.failure

/**
 * C-NOTIFY-1: the latest notification couldn't be sent. `role="alert"`, not
 * `status`: a failed send is something the Candidate needs to notice, so it is
 * announced when it renders rather than as passive status (Designer review
 * r1 proposal; it overrides design-spec.r4, which said `status`, so the owner
 * should confirm).
 */
export function NotifyFailureAlert({ failure, plain = false }: { failure: NotificationFailure; plain?: boolean }) {
  return (
    <Alert role="alert" className="border-warning/40 *:[svg]:text-warning-text">
      <MailWarning aria-hidden="true" />
      <AlertTitle>{c.title}</AlertTitle>
      <AlertDescription className="text-pretty">{c.text(failure.emailType, formatWatDateTime(failure.failedAt), plain)}</AlertDescription>
      <div className="col-start-2 mt-1.5 text-sm">
        <Link to={failure.targetPath} className="underline underline-offset-4">
          {c.link}
        </Link>
      </div>
    </Alert>
  )
}
