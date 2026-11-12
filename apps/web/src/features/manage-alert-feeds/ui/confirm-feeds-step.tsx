import { useRef, useState } from "react"
import { ShieldCheck } from "lucide-react"

import { findJobsCopy } from "@/entities/stack-post"
import { Button } from "@/shared/ui/button"
import { SectionNote } from "@/shared/ui/section"
import type { FeedList } from "../model/feed-list"
import { VerifyAlertSourceDialog } from "./verify-alert-source-dialog"

/**
 * "Confirm you may use these feeds": the one step at the top of Set up alerts (deck find.alerts.confirm.*),
 * shown while any feed list still has no confirmation. "I confirm" opens the existing date-and-basis dialog and
 * records every list that lacks one, with the same requests as before.
 */
export function ConfirmFeedsStep({ pending, id, onConfirmed }: { pending: readonly FeedList[]; id: string; onConfirmed?: () => void }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const c = findJobsCopy.alerts
  if (pending.length === 0) return null
  return (
    <SectionNote id={id} role="group" aria-labelledby={`${id}-title`} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-0.5">
          <h3 id={`${id}-title`} className="text-sm font-semibold">
            {c.confirmTitle}
          </h3>
          <p className="text-[0.8125rem] text-muted-foreground">{c.confirmBody}</p>
        </div>
      </div>
      <Button ref={buttonRef} className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        {c.confirmButton}
      </Button>
      <VerifyAlertSourceDialog
        list={pending}
        open={open}
        current={null}
        onClose={(saved) => {
          setOpen(false)
          // A saved confirmation removes this step, so focus moves to the next step: the Alert feeds' Feed URL field.
          if (saved) requestAnimationFrame(() => requestAnimationFrame(() => onConfirmed?.()))
          else requestAnimationFrame(() => buttonRef.current?.focus())
        }}
      />
    </SectionNote>
  )
}
