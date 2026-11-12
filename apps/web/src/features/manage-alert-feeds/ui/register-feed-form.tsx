import { forwardRef, useId, useImperativeHandle, useRef, useState, type FormEvent } from "react"
import { CircleAlert } from "lucide-react"

import { stackPostsCopy as c } from "@/entities/stack-post"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { FEED_LIST_COPY, type FeedList } from "../model/feed-list"
import { useRegisterFeed } from "../model/use-alert-feed-writes"
import { checkFeedForm } from "../model/validation"
import { feedFieldMessages, type FeedFieldMessages } from "../model/write-failure"

export interface RegisterFeedFormHandle {
  focusUrl: () => void
  /** The URL input, for a caller that must name a focus target before it acts (dialog focus return). */
  urlInput: () => HTMLInputElement | null
}

/**
 * Add an Alert feed (design-spec F4): URL and optional label, checked on
 * submit and then on every change once an error shows. Never disabled at 10,
 * so the limit line is reachable. On success the inputs clear, so the full URL
 * leaves the page (D-E5-5); on any refusal the typed values stay. A busy 503
 * (v1.15.2) shows C-SP-FEED-ERR-BUSY and is never retried by the page.
 * `list` (EPIC-0007 design-spec r2 H6 steps 7 to 9) picks the endpoint, the
 * URL helper, the limit, other-list and network lines, and the submit weight:
 * outline in the Hiring view, where Check this job holds the filled button (D9).
 */
export const RegisterFeedForm = forwardRef<RegisterFeedFormHandle, { feedCount: number; list?: FeedList }>(function RegisterFeedForm(
  { feedCount, list = "stack" },
  ref
) {
  const copy = FEED_LIST_COPY[list]
  const id = useId()
  const urlRef = useRef<HTMLInputElement>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState("")
  const [label, setLabel] = useState("")
  const [errors, setErrors] = useState<FeedFieldMessages>({})
  const [checking, setChecking] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const { register, isRegistering } = useRegisterFeed(list)
  useImperativeHandle(ref, () => ({ focusUrl: () => urlRef.current?.focus(), urlInput: () => urlRef.current }))

  const focusFirst = (next: FeedFieldMessages) => {
    if (next.url) urlRef.current?.focus()
    else if (next.label) labelRef.current?.focus()
  }

  const recheck = (next: { url: string; label: string }) => {
    if (checking) setErrors(checkFeedForm(next, feedCount, list))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isRegistering) return
    const next = checkFeedForm({ url, label }, feedCount, list)
    setErrors(next)
    setAlert(null)
    if (next.url || next.label) {
      setChecking(true)
      return focusFirst(next)
    }
    register(
      { url: url.trim(), label: label.trim() || null },
      {
        onDone: () => {
          setUrl("")
          setLabel("")
          setErrors({})
          setChecking(false)
          urlRef.current?.focus()
        },
        onFailed: (failure) => {
          if (failure.kind === "signed_out") return
          if (failure.kind === "fields") {
            const mapped = feedFieldMessages(failure.fieldErrors, list)
            setErrors(mapped)
            return requestAnimationFrame(() => focusFirst(mapped))
          }
          setAlert(failure.kind === "message" ? failure.message : failure.kind === "busy" ? c.feedErrBusy : copy.errNet)
          requestAnimationFrame(() => alertRef.current?.focus())
        },
      }
    )
  }

  const describedBy = (...ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined

  return (
    <form noValidate onSubmit={submit} aria-busy={isRegistering || undefined} className="flex flex-col gap-3 pt-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-col gap-1.5 lg:flex-[2]">
          <FieldLabel htmlFor={`${id}-url`}>{c.feedUrlLabel}</FieldLabel>
          <Input
            ref={urlRef}
            id={`${id}-url`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={c.feedUrlPlaceholder}
            value={url}
            readOnly={isRegistering}
            aria-invalid={errors.url ? true : undefined}
            aria-describedby={describedBy(!!errors.url && `${id}-url-error`, `${id}-url-help`)}
            onChange={(event) => {
              setUrl(event.target.value)
              recheck({ url: event.target.value, label })
            }}
          />
          {errors.url && (
            <FieldError id={`${id}-url-error`} className="text-destructive-text [overflow-wrap:anywhere]">
              {errors.url}
            </FieldError>
          )}
          <FieldDescription id={`${id}-url-help`}>{copy.urlHelp}</FieldDescription>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 lg:flex-1">
          <FieldLabel htmlFor={`${id}-label`}>
            {c.feedLabelLabel} <span className="font-normal text-muted-foreground">{c.optional}</span>
          </FieldLabel>
          <Input
            ref={labelRef}
            id={`${id}-label`}
            autoComplete="off"
            value={label}
            readOnly={isRegistering}
            aria-invalid={errors.label ? true : undefined}
            aria-describedby={describedBy(!!errors.label && `${id}-label-error`, `${id}-label-help`)}
            onChange={(event) => {
              setLabel(event.target.value)
              recheck({ url, label: event.target.value })
            }}
          />
          {errors.label && (
            <FieldError id={`${id}-label-error`} className="text-destructive-text">
              {errors.label}
            </FieldError>
          )}
          <FieldDescription id={`${id}-label-help`}>{c.feedLabelHelp}</FieldDescription>
        </div>
        <Button
          type="submit"
          variant={list === "hiring" ? "outline" : "default"}
          className="w-full sm:w-auto lg:mt-[1.375rem]" aria-busy={isRegistering || undefined}>
          {isRegistering && <ButtonSpinner />}
          {isRegistering ? c.feedChecking : c.feedAdd}
        </Button>
      </div>
      {alert && (
        <Alert variant="destructive" ref={alertRef} tabIndex={-1}>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{alert}</AlertTitle>
        </Alert>
      )}
    </form>
  )
})
