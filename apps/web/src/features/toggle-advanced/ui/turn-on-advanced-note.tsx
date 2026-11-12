import { EyeOff } from "lucide-react"

import { Button } from "@/shared/ui/button"
import { SectionNote } from "@/shared/ui/section"
import { advancedCopy } from "../model/copy"
import { useTurnOnAdvanced } from "../model/use-turn-on-advanced"

/** The hidden-route note (AC-3.6): one line and "Turn on Advanced". A failed write keeps the note and says so. */
export function TurnOnAdvancedNote() {
  const { turnOn, isPending, failed } = useTurnOnAdvanced()
  return (
    <SectionNote className="mx-4 flex max-w-[760px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:mx-6">
      <p className="flex items-start gap-2">
        <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>{advancedCopy.hiddenNote}</span>
      </p>
      <div className="flex flex-col gap-1">
        <Button variant="outline" size="sm" disabled={isPending} onClick={turnOn}>
          {advancedCopy.turnOn}
        </Button>
        {failed && (
          <p role="alert" className="text-[0.8125rem] text-destructive-text">
            {advancedCopy.turnOnError}
          </p>
        )}
      </div>
    </SectionNote>
  )
}
