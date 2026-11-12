import { useId } from "react"
import { CircleAlert, Lock } from "lucide-react"
import { Link } from "react-router-dom"

import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Label } from "@/shared/ui/label"
import { Switch } from "@/shared/ui/switch"
import { advancedCopy } from "../model/copy"
import { useToggleAdvanced } from "../model/use-toggle-advanced"

/**
 * The Advanced switch with its saving state, lock note and inline error. While automatic
 * applying is on the switch is disabled and the note says why (described by `aria-describedby`).
 */
export function AdvancedSwitch() {
  const { checked, locked, isPending, failed, toggle } = useToggleAdvanced()
  const noteId = useId()
  const errorId = useId()
  const describedBy = [locked ? noteId : null, failed ? errorId : null].filter(Boolean).join(" ") || undefined
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Switch
          id="advanced-switch"
          checked={checked}
          disabled={locked || isPending}
          aria-busy={isPending || undefined}
          aria-describedby={describedBy}
          onCheckedChange={(value) => toggle(value)}
        />
        <Label htmlFor="advanced-switch" className="text-sm font-medium">
          {advancedCopy.switchLabel}
        </Label>
        {isPending && <ButtonSpinner />}
      </div>
      {locked && (
        <p id={noteId} className="flex items-start gap-1.5 text-[0.8125rem] text-muted-foreground">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {advancedCopy.locked}{" "}
            <Link to="/pause-and-cost#automatic" className="text-foreground underline underline-offset-4">
              {advancedCopy.lockedLink}
            </Link>
          </span>
        </p>
      )}
      {failed && (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-[0.8125rem] text-destructive-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {advancedCopy.error}
        </p>
      )}
    </div>
  )
}
