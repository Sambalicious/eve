import { Info } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"

import { addedFactsCopy } from "../model/copy"

/**
 * The stale notice above Generate again (design-spec.r1 blueprint 5). Static text, not live: the Added
 * section's one live region speaks the change. No button inside: the one action is the existing
 * Generate again below it (C-AF-60, and C-AF-61 when the queue or the lift is affected).
 */
export function AddedFactsStaleNotice({ showQueueLine }: { showQueueLine: boolean }) {
  return (
    <Alert role={undefined} className="border-border">
      <Info aria-hidden="true" />
      <AlertTitle className="font-normal text-pretty">{addedFactsCopy.stale.notice}</AlertTitle>
      {showQueueLine && <AlertDescription className="text-[13px] text-muted-foreground">{addedFactsCopy.stale.queue}</AlertDescription>}
    </Alert>
  )
}
