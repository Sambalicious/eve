import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react"

import { homeCopy, type WaitingReason } from "@/entities/job-posting"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { Textarea } from "@/shared/ui/textarea"
import { homePasteProblems, homePasteRequest, looksLikeLink } from "../model/home-paste"
import type { PasteFieldMessages } from "../model/description"
import { pasteCopy } from "../model/paste-copy"
import { usePasteJobLink, type PasteOutcome } from "../model/use-paste-job-link"

export interface PastedJob {
  readonly postingId: string
  readonly waitingReason: WaitingReason | null
  /** The Application this job already has, when the server says so. */
  readonly applicationId: string | null
}

/**
 * Home's one paste box (R1): a link or the whole job description in the same field. When the text is
 * not a link, job title and company appear, because the API needs them for text. The submit sends the
 * existing paste request; the page shows the result in place.
 */
export function HomePasteBox({ onPasted, filled }: { onPasted: (job: PastedJob) => void; filled: boolean }) {
  const id = useId()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const companyRef = useRef<HTMLInputElement>(null)
  const [values, setValues] = useState({ text: "", title: "", company: "" })
  const [errors, setErrors] = useState<PasteFieldMessages>({})
  const [fetchFailed, setFetchFailed] = useState(false)
  const isText = values.text.trim() !== "" && !looksLikeLink(values.text)

  const { paste, isPasting } = usePasteJobLink({
    onOutcome: (outcome: PasteOutcome) => {
      if (outcome.kind === "created" || outcome.kind === "existing") {
        setValues({ text: "", title: "", company: "" })
        return onPasted({ postingId: outcome.posting.id, waitingReason: outcome.waitingReason, applicationId: null })
      }
      if (outcome.kind === "description") {
        setValues({ text: "", title: "", company: "" })
        return onPasted({
          postingId: outcome.result.posting.id,
          waitingReason: outcome.result.waitingReason,
          applicationId: outcome.result.applicationId,
        })
      }
      if (outcome.kind === "fields") {
        setErrors(outcome.messages)
        return focusFirst(outcome.messages)
      }
      if (outcome.kind === "alert") {
        if (outcome.alert.kind === "employer_page_unreadable") {
          setFetchFailed(true)
          setErrors({ title: pasteCopy.error.employer_page_unreadable })
          return textRef.current?.focus()
        }
        return
      }
      setErrors({ link: outcome.message })
      textRef.current?.focus()
    },
  })

  const focusFirst = (messages: PasteFieldMessages) => {
    if (messages.link || messages.description) return textRef.current?.focus()
    if (messages.title) return titleRef.current?.focus()
    if (messages.company) companyRef.current?.focus()
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (isPasting) return
    setFetchFailed(false)
    const problems = homePasteProblems(values)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return focusFirst(problems)
    paste(homePasteRequest(values))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !isText) submit()
  }

  const fieldError = errors.link ?? errors.description
  const describedBy = [`${id}-help`, fieldError && `${id}-error`].filter(Boolean).join(" ")

  return (
    <form noValidate onSubmit={submit} aria-busy={isPasting} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={id} className="sr-only">
          {homeCopy.paste.label}
        </FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Textarea
            ref={textRef}
            id={id}
            rows={1}
            value={values.text}
            readOnly={isPasting}
            placeholder={homeCopy.paste.placeholder}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={describedBy}
            className="max-h-60 min-h-10 flex-1 resize-none pointer-coarse:min-h-12"
            onKeyDown={onKeyDown}
            onChange={(event) => {
              setValues((current) => ({ ...current, text: event.target.value }))
              if (errors.link || errors.description) setErrors((current) => ({ ...current, link: undefined, description: undefined }))
            }}
          />
          <Button
            type="submit"
            variant={filled ? "default" : "outline"}
            className="h-10 w-full sm:w-auto pointer-coarse:h-12"
            aria-busy={isPasting}
            disabled={isPasting}
          >
            {isPasting && <ButtonSpinner />}
            {isPasting ? homeCopy.paste.submitting : homeCopy.paste.submit}
          </Button>
        </div>
        {fieldError && <FieldError id={`${id}-error`}>{fieldError}</FieldError>}
        <FieldDescription id={`${id}-help`}>{homeCopy.paste.helper}</FieldDescription>
      </div>
      {fetchFailed && (
        <p role="alert" className="text-sm text-destructive-text">
          {homeCopy.paste.errorFetch}
        </p>
      )}
      {(isText || fetchFailed) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${id}-title`}>{homeCopy.paste.titleLabel}</FieldLabel>
            <Input
              ref={titleRef}
              id={`${id}-title`}
              value={values.title}
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={errors.title ? `${id}-title-error` : undefined}
              onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
            />
            {errors.title && <FieldError id={`${id}-title-error`}>{errors.title}</FieldError>}
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${id}-company`}>{homeCopy.paste.companyLabel}</FieldLabel>
            <Input
              ref={companyRef}
              id={`${id}-company`}
              value={values.company}
              aria-invalid={errors.company ? true : undefined}
              aria-describedby={errors.company ? `${id}-company-error` : undefined}
              onChange={(event) => setValues((current) => ({ ...current, company: event.target.value }))}
            />
            {errors.company && <FieldError id={`${id}-company-error`}>{errors.company}</FieldError>}
          </div>
          <p className="text-[0.8125rem] text-muted-foreground sm:col-span-2">{homeCopy.paste.namesHelp}</p>
        </div>
      )}
    </form>
  )
}
