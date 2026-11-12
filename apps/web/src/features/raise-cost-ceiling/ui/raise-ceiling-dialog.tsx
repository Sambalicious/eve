import { useEffect, useId, useRef, type FormEvent } from "react"

import {
  automationCopy,
  ceilingDifference,
  firstOfNextMonth,
  monthLabel,
  type CostPause,
  type MonthlySpend,
} from "@/entities/automation-state"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/shared/ui/input-group"
import { useRaiseCeiling } from "../model/use-raise-ceiling"

const r = automationCopy.raise

interface RaiseCeilingProps {
  spend: MonthlySpend
  costPause: CostPause | null
  /** Render prop for the opening button, so the banner and Settings place it themselves. */
  trigger: (open: () => void) => React.ReactNode
}

/**
 * Raise ceiling dialog (Composite blocks) and its C-CONFIRM-18 alert-dialog.
 * When no raise is possible the field is replaced by C-COST-9 and "Close".
 */
export function RaiseCeiling({ spend, costPause, trigger }: RaiseCeilingProps) {
  const raise = useRaiseCeiling(spend)
  const month = monthLabel(spend.month)
  const returns = formatWatDate(firstOfNextMonth(spend.month))
  const resumes = formatWatDate(costPause?.resumesAt ?? firstOfNextMonth(spend.month))
  return (
    <>
      {trigger(raise.open)}
      <Dialog open={raise.step === "form"} onOpenChange={(open) => !open && !raise.isPending && raise.close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{r.title}</DialogTitle>
            <DialogDescription render={<div />} className="flex flex-col gap-0.5 tabular-nums">
              <span>{r.spent(spend.spent)}</span>
              <span>{r.current(spend.ceiling)}</span>
            </DialogDescription>
          </DialogHeader>
          {spend.canRaise ? (
            <CeilingForm
              month={month}
              help={r.help(spend.maxCeiling, month, returns, spend.defaultCeiling)}
              value={raise.value}
              error={raise.error}
              isPending={raise.isPending}
              onChange={raise.change}
              onSubmit={raise.submit}
              onCancel={raise.close}
            />
          ) : (
            <>
              <p className="text-sm text-pretty">{noRaiseLine(spend, resumes)}</p>
              <DialogFooter>
                <Button variant="outline" onClick={raise.close}>
                  {r.close}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={raise.step === "confirm"}
        onOpenChange={(open) => !open && raise.close()}
        title={r.confirm.title(raise.next ?? "")}
        body={r.confirm.body(raise.next ?? "", month, raise.next ? ceilingDifference(raise.next, spend.ceiling) : "", returns, spend.defaultCeiling)}
        confirmLabel={r.confirm.action}
        pendingLabel="Saving…"
        isPending={raise.isPending}
        onConfirm={raise.confirm}
      />
    </>
  )
}

/** C-COST-9: which of the two lines depends on whether spend reached the limit. */
function noRaiseLine(spend: MonthlySpend, resumes: string): string {
  const spendAtLimit = Number(spend.spent) >= Number(spend.maxCeiling)
  return spendAtLimit ? r.spendAtLimit(spend.spent, spend.maxCeiling, resumes) : r.atLimit(spend.maxCeiling, resumes)
}

function CeilingForm({
  month,
  help,
  value,
  error,
  isPending,
  onChange,
  onSubmit,
  onCancel,
}: {
  month: string
  help: string
  value: string
  error: string | null
  isPending: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  // Each refusal moves focus back to the field so the message is read with it.
  useEffect(() => {
    if (error) inputRef.current?.focus()
  }, [error])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit()
  }
  return (
    <form noValidate onSubmit={submit} className="grid gap-5">
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${id}-ceiling`}>
          <span aria-hidden="true">{r.field(month)}</span>
          <span className="sr-only">{r.fieldSr(month)}</span>
        </FieldLabel>
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>USD</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            id={`${id}-ceiling`}
            inputMode="decimal"
            autoComplete="off"
            required
            aria-required="true"
            aria-invalid={error ? true : undefined}
            aria-describedby={[`${id}-help`, error && `${id}-error`].filter(Boolean).join(" ")}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            ref={inputRef}
            className="tabular-nums"
          />
        </InputGroup>
        <FieldDescription id={`${id}-help`}>{help}</FieldDescription>
        {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending} aria-busy={isPending}>
          {isPending && <ButtonSpinner />}
          {r.continue}
        </Button>
      </DialogFooter>
    </form>
  )
}
