import { useId, useRef, useState, type FormEvent, type RefObject } from "react"

import { jobSourceCopy, type RemoteBoard } from "@/entities/job-source"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { HelpPopover, HelpPopoverLead, HelpPopoverNote } from "@/shared/ui/help-popover"
import { Input } from "@/shared/ui/input"
import { Textarea } from "@/shared/ui/textarea"
import { useVerifyRemoteBoard } from "../model/use-manage-remote-board"

/** Today in WAT as `YYYY-MM-DD`, the dialog's default date. */
function todayWat(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Mark verified dialog: date (default today) and basis, both required
 * (C-VAL-SRC-1). Uses a native date input in place of the calendar popover
 * (frontend report, deviation FE3-D1). Basis is limited to 2,000 characters
 * by the contract. EPIC-0009 adds the description (C-EH-VERIFY-DESC) with its
 * (i) popover, and the basis help line (C-EH-VERIFY-BASIS-HELP).
 */
export function MarkVerifiedDialog({ board, onClose }: { board: RemoteBoard | null; onClose: () => void }) {
  // Focus opens on the date field, not on the (i) that now precedes it (EPIC-0009 AC-4).
  const dateRef = useRef<HTMLInputElement>(null)
  return (
    <Dialog open={board !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" initialFocus={dateRef}>
        {board && <VerifyForm key={board.key} board={board} dateRef={dateRef} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

const copy = jobSourceCopy.verifyDialog

/** The dialog's (i): why the record is needed, with example bases (C-EH-VERIFY-WHY-*). */
function VerifyWhy() {
  const why = copy.why
  return (
    <HelpPopover triggerLabel={why.triggerSr} title={why.title}>
      <p>{why.p1}</p>
      <p>{why.p2}</p>
      <HelpPopoverLead>{why.examplesLead}</HelpPopoverLead>
      <ul className="flex list-disc flex-col gap-1.5 pl-4">
        {why.examples.map((example) => (
          <li key={example}>{example}</li>
        ))}
      </ul>
      <HelpPopoverNote>{why.note}</HelpPopoverNote>
    </HelpPopover>
  )
}

function VerifyForm({
  board,
  dateRef,
  onClose,
}: {
  board: RemoteBoard
  dateRef: RefObject<HTMLInputElement | null>
  onClose: () => void
}) {
  const id = useId()
  const basisRef = useRef<HTMLTextAreaElement>(null)
  const [date, setDate] = useState(todayWat)
  const [basis, setBasis] = useState("")
  const [errors, setErrors] = useState<{ date?: string; basis?: string }>({})
  const { verify, isVerifying } = useVerifyRemoteBoard({ onVerified: onClose })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? undefined : jobSourceCopy.verifyDialog.dateMissing,
      basis: basis.trim() ? undefined : jobSourceCopy.verifyDialog.basisMissing,
    }
    setErrors(next)
    if (next.date) return dateRef.current?.focus()
    if (next.basis) return basisRef.current?.focus()
    verify({ key: board.key, verifiedOn: date, basis: basis.trim() })
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          {jobSourceCopy.markVerified}: {board.name}
        </DialogTitle>
      </DialogHeader>
      <div className="flex items-start gap-1">
        <DialogDescription className="min-w-0 flex-1 text-pretty">{copy.description}</DialogDescription>
        <VerifyWhy />
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={`${id}-date`}>
          {jobSourceCopy.verifyDialog.date} <span className="text-muted-foreground">(Required)</span>
        </FieldLabel>
        <Input
          ref={dateRef}
          id={`${id}-date`}
          type="date"
          value={date}
          aria-required="true"
          aria-invalid={errors.date ? true : undefined}
          aria-describedby={errors.date ? `${id}-date-error` : undefined}
          onChange={(event) => setDate(event.target.value)}
        />
        {errors.date && <FieldError id={`${id}-date-error`}>{errors.date}</FieldError>}
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={`${id}-basis`}>
          {jobSourceCopy.verifyDialog.basis} <span className="text-muted-foreground">(Required)</span>
        </FieldLabel>
        <Textarea
          ref={basisRef}
          id={`${id}-basis`}
          value={basis}
          maxLength={2000}
          aria-required="true"
          aria-invalid={errors.basis ? true : undefined}
          aria-describedby={errors.basis ? `${id}-basis-help ${id}-basis-error` : `${id}-basis-help`}
          onChange={(event) => setBasis(event.target.value)}
        />
        <FieldDescription id={`${id}-basis-help`} className="text-pretty">
          {copy.basisHelp}
        </FieldDescription>
        {errors.basis && <FieldError id={`${id}-basis-error`}>{errors.basis}</FieldError>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={isVerifying}>
          Cancel
        </Button>
        <Button type="submit" aria-busy={isVerifying} disabled={isVerifying}>
          {isVerifying && <ButtonSpinner />}
          {isVerifying ? "Saving…" : jobSourceCopy.markVerified}
        </Button>
      </DialogFooter>
    </form>
  )
}
