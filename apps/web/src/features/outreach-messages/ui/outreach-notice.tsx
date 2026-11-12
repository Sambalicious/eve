import { CircleDollarSign, CirclePause, TriangleAlert } from "lucide-react"
import { useId } from "react"

import type { OutreachKind } from "@eve/contracts"
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { pauseNotice, type CauseNotice, type PauseKind } from "../model/outreach-state"

/**
 * The cause notice (`C-OM-20` to `C-OM-29`, then `C-OM-30`). Static: `role` is
 * removed so the section's live region is the only announcement. For `blocked`
 * with a stored sentence the children are, in order, the cause line, the label
 * `C-OM-53`, the quote and `C-OM-30` (design spec r1, sections 3 and 12).
 */
export function OutreachNotice({ notice }: { notice: CauseNotice }) {
  const labelId = useId()
  const hasQuote = notice.quote !== undefined && notice.quoteLabel !== undefined
  return (
    <Alert role={undefined} className="max-w-[72ch]">
      <TriangleAlert aria-hidden="true" className="text-warning-text!" />
      <AlertTitle className="font-normal text-pretty [overflow-wrap:anywhere]">{notice.line}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2 text-pretty [&_p:not(:last-child)]:mb-0">
        {hasQuote && (
          <div className="flex w-full min-w-0 flex-col gap-1.5">
            <p id={labelId} className="text-[13px] leading-normal font-semibold text-foreground">
              {notice.quoteLabel}
            </p>
            <blockquote
              aria-labelledby={labelId}
              dir="auto"
              // The rule is a shape, not decoration only: a 2px line needs 3:1
              // against the alert's surface (WCAG 1.4.11), and `--border` is
              // about 1.2:1 there, so the muted text shade carries it (F6).
              className="max-w-[72ch] border-l-2 border-muted-foreground pl-3 text-sm leading-normal whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] [unicode-bidi:isolate]"
            >
              {notice.quote}
            </blockquote>
          </div>
        )}
        {notice.link && (
          // A 40px minimum target, as every other control in the section (spec 12).
          <a href={notice.link.to} className="inline-flex min-h-10 items-center text-sm underline underline-offset-4">
            {notice.link.label}
          </a>
        )}
        {notice.earlierKept && <p className="text-[13px]">{notice.earlierKept}</p>}
      </AlertDescription>
    </Alert>
  )
}

/**
 * The pause note (`C-OM-31` or `C-OM-32`): `role=status`, muted warning tone,
 * not stored, never a failure. `C-OM-32` adds its cost link (G5: no Resume
 * control lives here, the shell banner owns it).
 */
export function OutreachPauseNote({ pause, kind }: { pause: PauseKind; kind: OutreachKind }) {
  const note = pauseNotice(pause, kind)
  const Icon = pause === "cost" ? CircleDollarSign : CirclePause
  return (
    <Alert role="status" className="max-w-[72ch]">
      <Icon aria-hidden="true" className="text-warning-text!" />
      <AlertTitle className="font-normal text-pretty [overflow-wrap:anywhere]">{note.line}</AlertTitle>
      {note.link && (
        <AlertDescription>
          <a href={note.link.to} className="inline-flex min-h-10 items-center underline underline-offset-4">
            {note.link.label}
          </a>
        </AlertDescription>
      )}
    </Alert>
  )
}
