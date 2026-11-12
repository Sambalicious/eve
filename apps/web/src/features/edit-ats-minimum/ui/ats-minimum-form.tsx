import { useId, useState, type FormEvent } from "react"

import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { Section } from "@/shared/ui/section"
import { useSaveAtsMinimum } from "../model/use-save-ats-minimum"

/**
 * The minimum ATS match for automatic submission (owner decision 2026-11-01). Below it, an automatic
 * submission waits in Blocked Applications and goes back to the queue once its resume reaches it.
 */
export function AtsMinimumForm({ minAtsPercent }: { minAtsPercent: number }) {
  const id = useId()
  const [value, setValue] = useState(String(minAtsPercent))
  const [error, setError] = useState<string | null>(null)
  const { save, isSaving } = useSaveAtsMinimum()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = Number(value)
    if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setError("Enter a whole number from 0 to 100.")
      return
    }
    setError(null)
    save(parsed)
  }

  return (
    <Section
      id="ats"
      title="ATS minimum"
      description="Eve scores every tailored resume against the posting's keywords, as an applicant tracking system would. Below this score, Eve won't submit automatically: the Application waits in Blocked Applications and goes back to the queue once its resume reaches it. 0 turns this off."
      layout="split"
      headingProps={{ id: `${id}-heading`, tabIndex: -1 }}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-value`}>Minimum ATS match (%)</FieldLabel>
          <Input
            id={`${id}-value`}
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : `${id}-help`}
            className="max-w-28"
          />
          <FieldDescription id={`${id}-help`}>Default 40. Samples you approve yourself are never held.</FieldDescription>
          {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
        </div>
        <div>
          <Button type="submit" aria-busy={isSaving} disabled={isSaving} focusableWhenDisabled>
            {isSaving && <ButtonSpinner />}
            Save
          </Button>
        </div>
      </form>
    </Section>
  )
}
