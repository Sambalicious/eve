import type { RefObject } from "react"
import { CircleX, Clock } from "lucide-react"

import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { Textarea } from "@/shared/ui/textarea"
import type { PasteFieldMessages, PasteFields } from "../model/description"
import { pasteCopy } from "../model/paste-copy"
import type { PasteFormAlert } from "../model/use-paste-job-link"

const OPEN_MOTION =
  "animate-in fade-in slide-in-from-top-1 duration-[180ms] ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none"
/** Design r1 Motion: close on Remove or success, 150ms. The caller unmounts it after 150ms. */
const EXIT_MOTION =
  "animate-out fade-out slide-out-to-top-1 fill-mode-forwards duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none"

export interface DescriptionPanelProps {
  readonly id: string
  /** `exit`: the inert copy that plays the close animation. */
  readonly motion?: "enter" | "exit"
  readonly fields: PasteFields
  readonly errors: PasteFieldMessages
  readonly count: number
  readonly overLimit: boolean
  readonly alert: PasteFormAlert | null
  readonly readOnly: boolean
  readonly descriptionRef: RefObject<HTMLTextAreaElement | null>
  readonly titleRef: RefObject<HTMLInputElement | null>
  readonly companyRef: RefObject<HTMLInputElement | null>
  readonly onEdit: (field: "description" | "title" | "company", value: string) => void
  readonly onRemove: () => void
}

/**
 * Design r1 B1, open: description with its help, counter and error; Job title
 * and Company (always shown, optional with a Greenhouse, Lever or Ashby link);
 * the names help; and the form-level alert slot above the send button.
 * Rendering only: values in, edits out.
 */
export function DescriptionPanel(props: DescriptionPanelProps) {
  const { id, fields, errors, alert } = props
  const alertId = `${id}-alert`
  const marked = (field: "title" | "company") => alert?.kind === "employer_page_unreadable" && alert.missing.includes(field)
  const describe = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(" ")
  const nameField = (field: "title" | "company", label: string, ref: RefObject<HTMLInputElement | null>) => {
    const error = errors[field]
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <FieldLabel htmlFor={`${id}-${field}`}>{label}</FieldLabel>
        <Input
          ref={ref}
          id={`${id}-${field}`}
          autoComplete="off"
          className="pointer-coarse:h-11"
          value={fields[field]}
          readOnly={props.readOnly}
          aria-invalid={error || marked(field) ? true : undefined}
          aria-describedby={describe(`${id}-names-help`, error && `${id}-${field}-error`, marked(field) && alertId)}
          onChange={(event) => props.onEdit(field, event.target.value)}
        />
        {error && <FieldError id={`${id}-${field}-error`}>{error}</FieldError>}
      </div>
    )
  }
  return (
    <div id={`${id}-panel`} className={`flex flex-col gap-4 ${props.motion === "exit" ? EXIT_MOTION : OPEN_MOTION}`}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-end justify-between gap-3">
          <FieldLabel htmlFor={`${id}-description`}>
            {pasteCopy.descriptionLabel} <span className="font-normal text-muted-foreground">({pasteCopy.optional})</span>
          </FieldLabel>
          <Button type="button" variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={props.onRemove}>
            {pasteCopy.remove}
          </Button>
        </div>
        <FieldDescription id={`${id}-description-help`}>{pasteCopy.descriptionHelp}</FieldDescription>
        <Textarea
          ref={props.descriptionRef}
          id={`${id}-description`}
          className="max-h-[50vh] min-h-40 overflow-y-auto font-sans whitespace-pre-wrap [overflow-wrap:anywhere]"
          value={fields.description}
          readOnly={props.readOnly}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={describe(`${id}-description-help`, `${id}-count`, errors.description && `${id}-description-error`)}
          onChange={(event) => props.onEdit("description", event.target.value)}
        />
        <div className="flex flex-wrap-reverse items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0 flex-1">
            {errors.description && <FieldError id={`${id}-description-error`}>{errors.description}</FieldError>}
          </div>
          <p
            className={`ml-auto text-[12.5px] tabular-nums transition-colors duration-150 motion-reduce:transition-none ${props.overLimit ? "text-destructive-text" : "text-muted-foreground"}`}
          >
            <span aria-hidden="true">{pasteCopy.count(props.count)}</span>
            <span id={`${id}-count`} className="sr-only">
              {pasteCopy.countSr(props.count)}
            </span>
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="grid gap-4 sm:grid-cols-2 sm:gap-3">
          {nameField("title", pasteCopy.titleLabel, props.titleRef)}
          {nameField("company", pasteCopy.companyLabel, props.companyRef)}
        </div>
        <FieldDescription id={`${id}-names-help`}>{pasteCopy.namesHelp}</FieldDescription>
      </div>
      {alert?.kind === "employer_page_unreadable" && (
        <Alert id={alertId} variant="destructive">
          <CircleX aria-hidden="true" />
          <AlertTitle className="font-normal text-pretty">{pasteCopy.error.employer_page_unreadable}</AlertTitle>
        </Alert>
      )}
      {alert?.kind === "posting_still_checking" && (
        <Alert id={alertId} className="*:[svg]:text-warning-text">
          <Clock aria-hidden="true" />
          <AlertTitle className="font-normal text-pretty">{pasteCopy.error.posting_still_checking}</AlertTitle>
        </Alert>
      )}
    </div>
  )
}
