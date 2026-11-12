import * as React from "react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Textarea } from "@/shared/ui/textarea"

interface ReasonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body?: string
  fieldLabel: string
  help?: string
  confirmLabel: string
  pendingLabel: string
  isPending: boolean
  destructive?: boolean
  /** Message for an empty or whitespace-only reason. */
  emptyMessage: string
  /** Message for a reason over `maxLength` characters. */
  tooLongMessage: string
  maxLength: number
  /** An error the server returned for the reason, shown under the field. */
  serverError?: string | null
  onConfirm: (reason: string) => void
}

/**
 * An alert-dialog with one required reason (sample reject, same-company
 * decline). Initial focus is on the textarea, because the dialog can't be
 * confirmed without typing. Escape counts as Cancel. The reason is kept while
 * the request runs and after a failure.
 */
export function ReasonDialog(props: ReasonDialogProps) {
  const { open, onOpenChange, isPending } = props
  return (
    <AlertDialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">{open && <ReasonForm {...props} />}</AlertDialogContent>
    </AlertDialog>
  )
}

function ReasonForm({
  title,
  body,
  fieldLabel,
  help,
  confirmLabel,
  pendingLabel,
  isPending,
  destructive = false,
  emptyMessage,
  tooLongMessage,
  maxLength,
  serverError,
  onConfirm,
}: ReasonDialogProps) {
  const id = React.useId()
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const ref = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => ref.current?.focus(), [])
  const shown = error ?? serverError ?? null

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const found = reason.trim() === "" ? emptyMessage : reason.length > maxLength ? tooLongMessage : null
    setError(found)
    if (found) {
      ref.current?.focus()
      return
    }
    onConfirm(reason)
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <AlertDialogHeader>
        <AlertDialogTitle className="[overflow-wrap:anywhere]">{title}</AlertDialogTitle>
        {body && <AlertDialogDescription>{body}</AlertDialogDescription>}
      </AlertDialogHeader>
      <Field data-invalid={shown ? true : undefined}>
        <FieldLabel htmlFor={`${id}-reason`}>
          {fieldLabel} <span className="font-normal text-muted-foreground">(Required)</span>
        </FieldLabel>
        <Textarea
          ref={ref}
          id={`${id}-reason`}
          value={reason}
          required
          aria-required="true"
          aria-invalid={shown ? true : undefined}
          aria-describedby={[help && `${id}-help`, shown && `${id}-error`].filter(Boolean).join(" ") || undefined}
          onChange={(event) => setReason(event.target.value)}
          className="max-h-60"
        />
        {help && <FieldDescription id={`${id}-help`}>{help}</FieldDescription>}
        {shown && <FieldError id={`${id}-error`}>{shown}</FieldError>}
      </Field>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
        <Button type="submit" variant={destructive ? "destructive" : "default"} aria-busy={isPending} disabled={isPending}>
          {isPending && <ButtonSpinner />}
          {isPending ? pendingLabel : confirmLabel}
        </Button>
      </AlertDialogFooter>
    </form>
  )
}
