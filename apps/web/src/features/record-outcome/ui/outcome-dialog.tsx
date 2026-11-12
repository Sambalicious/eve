import { useId, useState, type FormEvent } from "react"

import { OUTCOME_TYPES, outcomeCopy, type OutcomeType } from "@/entities/outcome"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/shared/ui/field"
import { NativeSelect } from "@/shared/ui/native-select"
import type { OutcomeTarget } from "../model/use-record-outcome"

/**
 * Record Outcome dialog (Composite blocks): one required type select and
 * "Save Outcome". Editing opens it with the current type selected.
 * OPEN[designer]: no title for the edit form and no message for an unselected type; uses "Record Outcome"/"Edit" and "Choose an Outcome type.".
 */
export function OutcomeDialog({
  target,
  isSaving,
  onClose,
  onSave,
}: {
  target: OutcomeTarget | null
  isSaving: boolean
  onClose: () => void
  onSave: (type: OutcomeType) => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{target && <OutcomeForm key={target.kind === "edit" ? target.outcome.id : "record"} target={target} isSaving={isSaving} onCancel={onClose} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

const CHOOSE_TYPE = "Choose an Outcome type."

function OutcomeForm({ target, isSaving, onCancel, onSave }: { target: OutcomeTarget; isSaving: boolean; onCancel: () => void; onSave: (type: OutcomeType) => void }) {
  const id = useId()
  const [type, setType] = useState<OutcomeType | "">(target.kind === "edit" ? target.outcome.type : "")
  const [error, setError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (type === "") return setError(CHOOSE_TYPE)
    onSave(type)
  }
  return (
    <form noValidate onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{target.kind === "edit" ? `${outcomeCopy.edit} Outcome` : outcomeCopy.record}</DialogTitle>
      </DialogHeader>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${id}-type`}>
          {outcomeCopy.typeLabel} <span className="font-normal text-muted-foreground">(Required)</span>
        </FieldLabel>
        <NativeSelect
          id={`${id}-type`}
          required
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          value={type}
          onChange={(event) => {
            setType(event.target.value as OutcomeType)
            setError(null)
          }}
        >
          <option value="" disabled>
            Choose…
          </option>
          {OUTCOME_TYPES.map((t) => (
            <option key={t} value={t}>
              {outcomeCopy.option[t]}
            </option>
          ))}
        </NativeSelect>
        {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving} aria-busy={isSaving}>
          {isSaving && <ButtonSpinner />}
          {isSaving ? outcomeCopy.saving : outcomeCopy.save}
        </Button>
      </DialogFooter>
    </form>
  )
}
