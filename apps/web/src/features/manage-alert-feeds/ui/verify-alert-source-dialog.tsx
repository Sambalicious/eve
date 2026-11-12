import { useId, useRef, useState, type FormEvent, type RefObject } from "react"
import { CircleAlert } from "lucide-react"
import { codePointLength, VERIFICATION_BASIS_MAX } from "@eve/contracts"

import { stackPostsCopy as c, type AlertFeedVerification } from "@/entities/stack-post"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Dialog, DialogContent, DialogDescription, DialogFooter } from "@/shared/ui/dialog"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { OverlayHeader } from "@/shared/ui/overlay-header"
import { Textarea } from "@/shared/ui/textarea"
import { FEED_LIST_COPY, type FeedList } from "../model/feed-list"
import { useSaveVerification } from "../model/use-alert-feed-writes"
import { checkVerification, todayWat } from "../model/validation"
import { verificationFieldMessages, type VerificationFieldMessages } from "../model/write-failure"

/**
 * Record or update the Alert feed verification (design-spec F3): date (today in
 * WAT by default, `max` today) and basis, both required. Update pre-fills the
 * stored record. The textarea has no `maxLength`, so a long paste reaches the
 * 500 check and its message.
 *
 * N-7 (design-spec r2, Revision r2 item 1): this dialog only is capped at the
 * viewport height minus 32px. The title and the actions are pinned; the fields
 * scroll between them, and the basis grows to 192px before it scrolls inside.
 *
 * EPIC-0007 design-spec r2 H6b, EPIC-0008 design-spec S2: `list` picks the copy
 * and the save mutation only. Both lists save the session Candidate's own
 * permitted-use record for that list, and both show a help line as the
 * dialog's description. Both lists use `OverlayHeader` (title and close on one
 * row, divider), so the corner close moves into the header row (OQ5).
 * `onClose(saved)` tells the opener whether a save closed it.
 */
export function VerifyAlertSourceDialog({
  open,
  current,
  onClose,
  list = "stack",
}: {
  open: boolean
  current: AlertFeedVerification | null
  onClose: (saved: boolean) => void
  list?: FeedList | readonly FeedList[]
}) {
  // Initial focus goes to the date field (design-spec r2 H6b step 1, EPIC-0005 F3), not to
  // the OverlayHeader's Close, which is first in tab order (design-review phase 3 B-1).
  const dateRef = useRef<HTMLInputElement>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose(false)}>
      <DialogContent
        showCloseButton={false}
        initialFocus={dateRef}
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-lg"
      >
        {open && <VerifyForm current={current} onClose={onClose} list={list} dateRef={dateRef} />}
      </DialogContent>
    </Dialog>
  )
}

function VerifyForm({
  current,
  onClose,
  list,
  dateRef,
}: {
  current: AlertFeedVerification | null
  onClose: (saved: boolean) => void
  list: FeedList | readonly FeedList[]
  dateRef: RefObject<HTMLInputElement | null>
}) {
  const copy = FEED_LIST_COPY[typeof list === "string" ? list : list[0]]
  const id = useId()
  const basisRef = useRef<HTMLTextAreaElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const [date, setDate] = useState(() => current?.verifiedOn ?? todayWat())
  const [basis, setBasis] = useState(() => current?.basis ?? "")
  const [errors, setErrors] = useState<VerificationFieldMessages>({})
  const [alert, setAlert] = useState<string | null>(null)
  const { save, isSaving } = useSaveVerification(list)
  const count = codePointLength(basis.trim())

  const focusFirst = (next: VerificationFieldMessages) => {
    if (next.date) focusInBody(dateRef.current)
    else if (next.basis) focusInBody(basisRef.current)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = checkVerification({ date, basis })
    setErrors(next)
    setAlert(null)
    if (next.date || next.basis) return focusFirst(next)
    save(
      { verifiedOn: date, verificationBasis: basis.trim() },
      {
        onDone: () => onClose(true),
        onFailed: (failure) => {
          if (failure.kind === "signed_out") return
          if (failure.kind === "fields") {
            const mapped = verificationFieldMessages(failure.fieldErrors)
            setErrors(mapped)
            return requestAnimationFrame(() => focusFirst(mapped))
          }
          setAlert(failure.kind === "message" ? failure.message : copy.verifyErrNet)
          requestAnimationFrame(() => focusInBody(alertRef.current))
        },
      }
    )
  }

  const describedBy = (...ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined

  return (
    <form noValidate onSubmit={submit} aria-busy={isSaving || undefined} className="flex min-h-0 flex-1 flex-col gap-4">
      <OverlayHeader title={copy.verifyDialogTitle} closeLabel={c.close} className="-mx-6 -mt-6 flex-none" />
      <div
        data-slot="verify-dialog-body"
        className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-1"
      >
        <DialogDescription className="text-pretty">{copy.verifyDialogHelp}</DialogDescription>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-date`}>
            {c.verifyDateLabel} <span className="text-muted-foreground">{c.required}</span>
          </FieldLabel>
          <Input
            ref={dateRef}
            id={`${id}-date`}
            type="date"
            value={date}
            max={todayWat()}
            readOnly={isSaving}
            aria-required="true"
            aria-invalid={errors.date ? true : undefined}
            aria-describedby={describedBy(!!errors.date && `${id}-date-error`)}
            onChange={(event) => setDate(event.target.value)}
          />
          {errors.date && <FieldError id={`${id}-date-error`}>{errors.date}</FieldError>}
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-basis`}>
            {c.verifyBasisLabel} <span className="text-muted-foreground">{c.required}</span>
          </FieldLabel>
          <Textarea
            ref={basisRef}
            id={`${id}-basis`}
            value={basis}
            readOnly={isSaving}
            aria-required="true"
            aria-invalid={errors.basis ? true : undefined}
            aria-describedby={describedBy(`${id}-basis-help`, `${id}-basis-count`, !!errors.basis && `${id}-basis-error`)}
            className="max-h-48 overflow-y-auto [overflow-wrap:anywhere]"
            onChange={(event) => setBasis(event.target.value)}
          />
          <div className="flex items-start justify-between gap-4">
            <FieldDescription id={`${id}-basis-help`}>{c.verifyBasisHelp}</FieldDescription>
            <span
              id={`${id}-basis-count`}
              className={`shrink-0 text-xs tabular-nums ${count > VERIFICATION_BASIS_MAX ? "text-destructive-text" : "text-muted-foreground"}`}
            >
              {c.verifyBasisCount(count)}
            </span>
          </div>
          {errors.basis && <FieldError id={`${id}-basis-error`}>{errors.basis}</FieldError>}
        </div>
        {alert && (
          <Alert variant="destructive" ref={alertRef} tabIndex={-1} role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{alert}</AlertTitle>
          </Alert>
        )}
      </div>
      <DialogFooter className="flex-none">
        <Button type="button" variant="outline" onClick={() => onClose(false)} disabled={isSaving}>
          {c.cancel}
        </Button>
        <Button type="submit" aria-busy={isSaving || undefined} disabled={isSaving}>
          {isSaving && <ButtonSpinner />}
          {isSaving ? c.saving : copy.verifySubmit}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Focus an element in the scrolling body and bring it into view there; the title and actions do not move. */
function focusInBody(element: HTMLElement | null) {
  if (!element) return
  element.focus()
  element.scrollIntoView?.({ block: "nearest" })
}
