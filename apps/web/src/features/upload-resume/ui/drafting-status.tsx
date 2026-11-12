import { LoaderCircle } from "lucide-react"

import {
  careerProfileCopy,
  hasDraftingTimedOut,
} from "@/entities/career-profile"

/**
 * The in-place status line while background drafting runs
 * (`aria-live="polite"`): C-PROFILE-2, or C-ERR-4 after the polling limit.
 * A failed attempt is shown by the drop zone instead, with its retry action.
 */
export function DraftingStatus({
  filename,
  startedAt,
}: {
  filename: string
  startedAt: string
}) {
  return (
    <div
      aria-live="polite"
      className="rounded-xl bg-muted/60 px-4 py-3.5 text-sm"
    >
      <p className="flex items-center gap-2">
        <LoaderCircle
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
        <span className="[overflow-wrap:anywhere]">
          {hasDraftingTimedOut(startedAt)
            ? careerProfileCopy.pollingTimedOut
            : careerProfileCopy.drafting(filename)}
        </span>
      </p>
    </div>
  )
}
