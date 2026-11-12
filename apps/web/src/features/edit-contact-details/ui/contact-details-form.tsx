import { useId, useRef, useState, type FormEvent } from "react"
import { Plus, X } from "lucide-react"

import {
  CONTACT_LINES_MAX,
  type ContactDetails,
} from "@/entities/candidate-settings"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Section } from "@/shared/ui/section"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import {
  contactFormCopy,
  validateContact,
  type ContactFormErrors,
} from "../model/contact-form"
import { useSaveContactDetails } from "../model/use-save-contact-details"

/**
 * Settings, "Contact details" (`#contact`, C-SET-3 to C-SET-6): the name
 * generation needs and up to 6 contact lines, each its own input with "Add
 * line" and "Remove line {k}". No `maxLength`: a pasted value would be cut
 * silently, so the limit is explained instead (C-VAL-SET-4).
 */
export function ContactDetailsForm({ contact }: { contact: ContactDetails }) {
  const id = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const lineRefs = useRef<(HTMLInputElement | null)[]>([])
  const addRef = useRef<HTMLButtonElement>(null)
  const [fullName, setFullName] = useState(contact.fullName)
  // Stable keys, so removing line 2 doesn't move line 3's focus or value.
  const nextKey = useRef(contact.lines.length)
  const [lines, setLines] = useState(() =>
    contact.lines.map((value, key) => ({ key, value }))
  )
  const [errors, setErrors] = useState<ContactFormErrors>({})
  const { save, isSaving } = useSaveContactDetails()

  const addLine = () => {
    const key = nextKey.current++
    setLines((current) => [...current, { key, value: "" }])
    requestAnimationFrame(() => lineRefs.current[lines.length]?.focus())
  }
  const removeLine = (index: number) => {
    setLines((current) => current.filter((_, i) => i !== index))
    setErrors((current) => ({ ...current, lines: undefined }))
    requestAnimationFrame(() =>
      (
        lineRefs.current[index] ??
        lineRefs.current[index - 1] ??
        addRef.current
      )?.focus()
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isSaving) return
    const result = validateContact(
      fullName,
      lines.map((l) => l.value)
    )
    setErrors(result.errors)
    if (result.errors.fullName) return nameRef.current?.focus()
    const firstBadLine = result.errors.lines
      ? Number(Object.keys(result.errors.lines)[0])
      : null
    if (firstBadLine !== null) return lineRefs.current[firstBadLine]?.focus()
    if (result.errors.linesField) return lineRefs.current[0]?.focus()
    if (result.value) save(result.value)
  }

  return (
    <Section
      id="contact"
      title={contactFormCopy.heading}
      description={contactFormCopy.help}
      layout="split"
      headingProps={{ id: `${id}-heading`, tabIndex: -1 }}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-name`}>
            {contactFormCopy.nameLabel}{" "}
            <span className="text-muted-foreground">
              ({contactFormCopy.required})
            </span>
          </FieldLabel>
          <Input
            ref={nameRef}
            id={`${id}-name`}
            autoComplete="name"
            value={fullName}
            aria-required="true"
            aria-invalid={errors.fullName ? true : undefined}
            aria-describedby={errors.fullName ? `${id}-name-error` : undefined}
            onChange={(event) => setFullName(event.target.value)}
          />
          {errors.fullName && (
            <FieldError id={`${id}-name-error`}>{errors.fullName}</FieldError>
          )}
        </div>
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={`${id}-lines-help${errors.linesField ? ` ${id}-lines-error` : ""}`}
        >
          <legend className="mb-1.5 text-sm font-medium">
            {contactFormCopy.linesLabel}
          </legend>
          <FieldDescription id={`${id}-lines-help`}>
            {contactFormCopy.linesHelp}
          </FieldDescription>
          {lines.map((line, index) => {
            const error = errors.lines?.[index]
            const k = index + 1
            return (
              <div key={line.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Input
                    ref={(el) => {
                      lineRefs.current[index] = el
                    }}
                    aria-label={contactFormCopy.lineLabel(k)}
                    value={line.value}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={
                      error ? `${id}-line-${line.key}-error` : undefined
                    }
                    onChange={(event) => {
                      const value = event.target.value
                      setLines((current) =>
                        current.map((l, i) =>
                          i === index ? { ...l, value } : l
                        )
                      )
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={contactFormCopy.removeLine(k)}
                    onClick={() => removeLine(index)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {error && (
                  <FieldError id={`${id}-line-${line.key}-error`}>
                    {error}
                  </FieldError>
                )}
              </div>
            )
          })}
          {errors.linesField && (
            <FieldError id={`${id}-lines-error`}>
              {errors.linesField}
            </FieldError>
          )}
          <div>
            <Button
              ref={addRef}
              type="button"
              variant="outline"
              size="sm"
              onClick={addLine}
              disabled={lines.length >= CONTACT_LINES_MAX}
            >
              <Plus aria-hidden="true" />
              {contactFormCopy.addLine}
            </Button>
          </div>
        </fieldset>
        <div>
          <Button type="submit" aria-busy={isSaving} disabled={isSaving} focusableWhenDisabled>
            {isSaving && <ButtonSpinner />}
            {isSaving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Section>
  )
}
