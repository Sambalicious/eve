import { useId, useRef, useState, type FormEvent, type Ref } from "react"
import { CircleAlert, Info } from "lucide-react"
import { cn } from "cn"

import {
  existingApplicationCopy as c,
  type ExistingApplication,
} from "@/entities/existing-application"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import {
  emptyExistingApplicationForm,
  FIELD_ORDER,
  toNewExistingApplication,
  validateExistingApplication,
  type ExistingApplicationField,
  type ExistingApplicationFormErrors,
  type ExistingApplicationFormValues,
} from "../model/existing-application-form"
import { useAddExistingApplication } from "../model/use-add-existing-application"
import { DateAppliedPicker } from "./date-applied-picker"

interface ExistingApplicationFormProps {
  /** `row`: fields in one row that wraps (768px and up); `stacked`: the mobile sheet. */
  layout: "row" | "stacked"
  /** After a 201. The inline form clears and focuses "Company"; the sheet closes. */
  onAdded?: () => void
  /** C-EXIST-3's "View it": scroll to the stored row and highlight it. */
  onViewIt: (id: string) => void
  /**
   * Whether the submit is the view's filled primary (DESIGN.md rule 1). False
   * on the page while "Mark this step complete" is the primary (DR-EA-01).
   */
  primary?: boolean
}

/**
 * "Add existing application" (F1 step 6a.2 to 6a.6): Company, Role, Employer
 * application URL, Requisition ID (optional) with C-EXIST-6, Date applied.
 * Client checks first (C-VAL-EXIST-1, C-VAL-EXIST-2); the backend's 422 shows
 * under its field and its 400 as one inline alert. An already-recorded
 * application keeps the values and shows C-EXIST-3 with "View it". Every
 * refusal keeps what was typed.
 */
export function ExistingApplicationForm({
  layout,
  onAdded,
  onViewIt,
  primary = true,
}: ExistingApplicationFormProps) {
  const id = useId()
  const [values, setValues] = useState<ExistingApplicationFormValues>(
    emptyExistingApplicationForm
  )
  const [errors, setErrors] = useState<ExistingApplicationFormErrors>({})
  const [badRequest, setBadRequest] = useState(false)
  const [duplicate, setDuplicate] = useState<ExistingApplication | null>(null)
  const ownCompanyRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const roleRef = useRef<HTMLInputElement>(null)
  const dateRef = useRef<HTMLButtonElement>(null)
  const fieldRefs: Record<
    ExistingApplicationField,
    { current: HTMLElement | null }
  > = {
    company: ownCompanyRef,
    roleTitle: roleRef,
    applicationUrl: urlRef,
    appliedOn: dateRef,
  }
  const focusField = (field: ExistingApplicationField) =>
    queueMicrotask(() => fieldRefs[field].current?.focus())

  const { add, isAdding } = useAddExistingApplication({
    onAdded: () => {
      setValues(emptyExistingApplicationForm)
      setErrors({})
      if (onAdded) onAdded()
      else focusField("company")
    },
    onAlreadyRecorded: setDuplicate,
    onFieldError: (field, message) => {
      setErrors({ [field]: message })
      focusField(field)
    },
    onBadRequest: () => setBadRequest(true),
  })

  const set = (field: keyof ExistingApplicationFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
    setDuplicate(null)
    setBadRequest(false)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isAdding) return
    const found = validateExistingApplication(values)
    setErrors(found)
    setBadRequest(false)
    setDuplicate(null)
    const first = FIELD_ORDER.find((field) => found[field])
    if (first) return focusField(first)
    add(toNewExistingApplication(values))
  }

  const fieldClass =
    layout === "row" ? "min-w-[min(100%,12rem)] flex-1" : "w-full"
  const describedBy = (field: string, help?: boolean) =>
    [
      help && `${id}-${field}-help`,
      errors[field as ExistingApplicationField] && `${id}-${field}-error`,
    ]
      .filter(Boolean)
      .join(" ") || undefined

  const textField = (
    field: Exclude<ExistingApplicationField, "appliedOn">,
    ref: Ref<HTMLInputElement>,
    extra: { type?: string; inputMode?: "url" } = {}
  ) => (
    <div className={cn("flex flex-col gap-1.5", fieldClass)}>
      <FieldLabel htmlFor={`${id}-${field}`}>{c.fields[field]}</FieldLabel>
      <Input
        ref={ref}
        id={`${id}-${field}`}
        value={values[field]}
        aria-required="true"
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={describedBy(field)}
        autoComplete="off"
        {...extra}
        onChange={(event) => set(field, event.target.value)}
      />
      {errors[field] && (
        <FieldError id={`${id}-${field}-error`}>{errors[field]}</FieldError>
      )}
    </div>
  )

  const submitButton = (
    <Button
      type="submit"
      variant={primary ? "default" : "outline"}
      aria-busy={isAdding}
      disabled={isAdding}
      className={layout === "stacked" ? "w-full" : undefined}
    >
      {isAdding && <ButtonSpinner />}
      {isAdding ? c.addPending : c.addButton}
    </Button>
  )

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div
        className={cn(
          "flex gap-4",
          layout === "row" ? "flex-wrap items-start" : "flex-col"
        )}
      >
        {textField("company", ownCompanyRef)}
        {textField("roleTitle", roleRef)}
        {textField("applicationUrl", urlRef, { type: "url", inputMode: "url" })}
        <div className={cn("flex flex-col gap-1.5", fieldClass)}>
          <FieldLabel htmlFor={`${id}-requisitionId`}>
            {c.fields.requisitionId}
          </FieldLabel>
          <Input
            id={`${id}-requisitionId`}
            value={values.requisitionId}
            aria-describedby={`${id}-requisitionId-help`}
            autoComplete="off"
            onChange={(event) => set("requisitionId", event.target.value)}
          />
          <FieldDescription id={`${id}-requisitionId-help`}>
            {c.requisitionHelp}
          </FieldDescription>
        </div>
        <div
          className={cn(
            "flex flex-col gap-1.5",
            fieldClass,
            layout === "row" && "max-w-[15rem]"
          )}
        >
          <FieldLabel id={`${id}-appliedOn-label`} htmlFor={`${id}-appliedOn`}>
            {c.fields.appliedOn}
          </FieldLabel>
          <DateAppliedPicker
            id={`${id}-appliedOn`}
            labelId={`${id}-appliedOn-label`}
            value={values.appliedOn}
            invalid={errors.appliedOn !== undefined}
            describedBy={describedBy("appliedOn")}
            triggerRef={dateRef}
            onChange={(value) => set("appliedOn", value)}
          />
          {errors.appliedOn && (
            <FieldError id={`${id}-appliedOn-error`}>
              {errors.appliedOn}
            </FieldError>
          )}
        </div>
      </div>
      <div role="status" aria-live="polite" className="empty:hidden">
        {duplicate && (
          <Alert>
            <Info aria-hidden="true" />
            <AlertTitle className="font-normal [overflow-wrap:anywhere]">
              {c.alreadyRecorded(
                duplicate.roleTitle,
                duplicate.company,
                duplicate.appliedOn
              )}{" "}
              <button
                type="button"
                className="font-medium underline underline-offset-4"
                onClick={() => onViewIt(duplicate.id)}
              >
                {c.viewIt}
              </button>
            </AlertTitle>
          </Alert>
        )}
      </div>
      {badRequest && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="font-normal">
            {c.malformed.badRequest}
          </AlertTitle>
        </Alert>
      )}
      <div>{submitButton}</div>
    </form>
  )
}
