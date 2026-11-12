import { CircleAlert, Info } from "lucide-react"

import { isNotYetAvailable } from "@/shared/lib/not-yet-available"
import { Alert, AlertAction, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"

export const NOT_AVAILABLE_NOTE = "Automatic applying isn't available on your account yet."

/**
 * C-ERR-1, shown at the top of the content area when a page's data fails to
 * load. A page with a copy deck passes its keyed strings; the defaults are C-ERR-1.
 */
export function LoadErrorAlert({
  onRetry,
  title = "Couldn't load this page.",
  retryLabel = "Try again",
  error,
}: {
  onRetry: () => void
  title?: string
  retryLabel?: string
  /** The failed query's error. A 409 `feature_not_yet_available` is not a failure to retry: it shows a plain note. */
  error?: unknown
}) {
  // F-02 (owner ruled 2026-11-08): what an invited user sees where automatic applying isn't open to them yet.
  if (isNotYetAvailable(error)) {
    return (
      <Alert role="note">
        <Info aria-hidden="true" />
        <AlertTitle className="font-normal">{NOT_AVAILABLE_NOTE}</AlertTitle>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      </AlertAction>
    </Alert>
  )
}
