import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ACCESS_REQUEST_HONEYPOT_FIELD, trimAccessRequestEmail } from "@eve/contracts"
import { CircleAlert, CircleCheck, WifiOff } from "lucide-react"

import { Button } from "@/shared/ui/button"
import { isInToaster, toast } from "@/shared/ui/toast"
import { DialogClose, DialogDescription } from "@/shared/ui/dialog"
import { requestCopy as c } from "../model/copy"
import {
  emailErrorFor,
  isNoResponse,
  noteHelper,
  outcomeOf,
  validateForm,
  type EmailError,
  type FieldErrors,
  type SendPanel,
} from "../model/form-state"
import { useRequestAccess } from "../model/use-request-access"
import { ClockIcon, FormInput, FormSpinner, FormTextarea } from "./fields"

export interface RequestAccessFormProps {
  /** `Date.now()` when the dialog opened, for the fill-time alignment rule. */
  openedAt: number
  /** Puts text in the dialog's polite status region (success only, design-spec r3). */
  onAnnounce: (text: string) => void
  /** The dialog's own toaster; send failures render there one at a time (`${toasterId}-send-N`). */
  toasterId: string
}

/**
 * The request form and its success state (design-spec r3 S2). Lives in its
 * own lazy chunk. Field errors are inline and reached by focus; send
 * failures are one persistent toast in the dialog's toaster, with Try again
 * only for network failures; success replaces the form in the same grid
 * cell so the panel keeps its height.
 */
export function RequestAccessForm({ openedAt, onAnnounce, toasterId }: RequestAccessFormProps) {
  const { send } = useRequestAccess(openedAt)
  const [email, setEmail] = useState("")
  const [note, setNote] = useState("")
  const [errors, setErrors] = useState<FieldErrors>({})
  // A fresh id per failure (F-QA-E3C-02): Sonner 2.0.8 removes a toast re-created
  // under an id whose dismissal it is still delivering, so reusing one id can
  // leave the retry's failure with no toast. One toast at a time still holds:
  // the previous one is dismissed before each send.
  const sendToast = useRef<{ n: number; id: string | null }>({ n: 0, id: null })
  const dismissSendToast = () => {
    if (sendToast.current.id !== null) toast.dismiss(sendToast.current.id)
    sendToast.current.id = null
  }
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const emailRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const honeypotRef = useRef<HTMLInputElement>(null)
  const ids = { email: useId(), emailError: useId(), note: useId(), noteHelper: useId(), noteError: useId(), honeypot: useId() }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Focus moves to the email field only if the visitor hasn't moved it while the chunk loaded.
  // Focus in the dialog's toaster doesn't count: there it is the load-error toast's Try again,
  // and that toast is dismissed as the form arrives (DR-E3F-01).
  useLayoutEffect(() => {
    const panelElement = emailRef.current?.closest<HTMLElement>('[role="dialog"]')
    const active = document.activeElement
    const visitorMovedFocus = !!panelElement && active !== panelElement && panelElement.contains(active) && !isInToaster(active)
    if (!visitorMovedFocus) emailRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (done) closeRef.current?.focus()
  }, [done])

  const focusField = (field: "email" | "note") => (field === "email" ? emailRef : noteRef).current?.focus()

  async function submit(refreshProof: boolean) {
    if (inFlight.current) return
    const trimmed = trimAccessRequestEmail(email)
    if (trimmed !== email) setEmail(trimmed)
    const checked = validateForm(email, note)
    if (!checked.ok) {
      setErrors(checked.errors)
      dismissSendToast()
      focusField(checked.first)
      return
    }
    inFlight.current = true
    setPending(true)
    setErrors({})
    // A new send removes the open send toast, so two never stack for one form.
    dismissSendToast()
    try {
      await send({ email: checked.email, note: checked.note, honeypot: honeypotRef.current?.value ?? "" }, { refreshProof })
      if (!mounted.current) return
      setDone(true)
      onAnnounce(`${c.successHeading}. ${c.successBody}`)
    } catch (error) {
      if (!mounted.current) return
      const outcome = outcomeOf(error)
      if (outcome.kind === "fields") {
        setErrors(outcome.fields)
        focusField(outcome.fields.email ? "email" : "note")
      } else {
        showSendToast(outcome.panel, isNoResponse(error))
        submitRef.current?.focus()
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }

  function showSendToast(kind: SendPanel, offline: boolean) {
    dismissSendToast()
    const id = `${toasterId}-send-${++sendToast.current.n}`
    sendToast.current.id = id
    const options = {
      id,
      toasterId,
      duration: Infinity,
      // Focus closing the toast lands on Send request (r3 Announcements and focus).
      onClose: () => submitRef.current?.focus(),
    }
    if (kind === "rate_ip" || kind === "rate_global") {
      toast.warning(c.panel[kind], { ...options, icon: ClockIcon })
    } else if (kind === "network") {
      toast.error(c.panel.network, {
        ...options,
        icon: offline ? WifiOff : CircleAlert,
        action: {
          label: c.retry,
          onClick: () => {
            submitRef.current?.focus()
            void submit(true)
          },
        },
      })
    } else {
      toast.error(c.panel.rejected, options)
    }
  }

  const onEmailChange = (value: string) => {
    setEmail(value)
    if (errors.email && !emailErrorFor(value) && trimAccessRequestEmail(value) !== "") setErrors((e) => ({ ...e, email: undefined }))
  }
  const onEmailBlur = () => {
    const trimmed = trimAccessRequestEmail(email)
    if (trimmed !== email) setEmail(trimmed)
    const error = emailErrorFor(trimmed)
    if (error) setErrors((e) => ({ ...e, email: error }))
  }
  const onNoteChange = (value: string) => {
    setNote(value)
    if (errors.note && noteHelper(value).kind !== "over") setErrors((e) => ({ ...e, note: undefined }))
  }

  const helper = noteHelper(note)
  const emailError: EmailError | undefined = errors.email

  return (
    <div className="grid">
      <form
        noValidate
        aria-hidden={done || undefined}
        inert={done || undefined}
        onSubmit={(event) => {
          event.preventDefault()
          void submit(false)
        }}
        className="request-swap grid gap-5 px-6 pt-5 pb-6 [grid-area:1/1] data-[done]:invisible data-[done]:opacity-0"
        data-done={done || undefined}
      >
        {done ? (
          <p className="text-sm text-muted-foreground">{c.intro}</p>
        ) : (
          <DialogDescription className="text-sm leading-normal">{c.intro}</DialogDescription>
        )}

        <div className="grid gap-2">
          <label htmlFor={ids.email} className="text-[13.5px] leading-snug font-medium">
            {c.emailLabel}
          </label>
          <FormInput
            ref={emailRef}
            id={ids.email}
            data-autofocus=""
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="off"
            spellCheck={false}
            required
            placeholder={c.emailPlaceholder}
            value={email}
            readOnly={pending}
            onChange={(event) => onEmailChange(event.target.value)}
            onBlur={onEmailBlur}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? ids.emailError : undefined}
            className="h-10 scroll-my-6 lg:h-8 pointer-coarse:h-11"
          />
          {emailError && (
            <p id={ids.emailError} className="-mt-0.5 flex items-start gap-1.5 text-[13px] leading-snug text-destructive-text">
              <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              {c.emailError[emailError]}
            </p>
          )}
        </div>

        <div className="grid gap-2">
          <label htmlFor={ids.note} className="text-[13.5px] leading-snug font-medium">
            {c.noteLabel}
          </label>
          <FormTextarea
            ref={noteRef}
            id={ids.note}
            name="note"
            rows={4}
            dir="auto"
            value={note}
            readOnly={pending}
            onChange={(event) => onNoteChange(event.target.value)}
            aria-invalid={errors.note ? true : undefined}
            aria-describedby={[ids.noteHelper, errors.note ? ids.noteError : null].filter(Boolean).join(" ")}
            className="max-h-60 min-h-22 scroll-my-6 resize-y [field-sizing:fixed] [overflow-wrap:anywhere]"
          />
          <p
            id={ids.noteHelper}
            className={
              helper.kind === "over"
                ? "-mt-0.5 text-right text-[13px] text-destructive-text tabular-nums"
                : helper.kind === "left"
                  ? "-mt-0.5 text-right text-[13px] text-muted-foreground tabular-nums"
                  : "-mt-0.5 text-[13px] text-muted-foreground"
            }
          >
            {helper.kind === "hint" ? c.noteHint : helper.kind === "left" ? c.noteCounter(helper.count) : c.noteCounterOver(helper.count)}
          </p>
          {errors.note && (
            <p id={ids.noteError} className="-mt-1 flex items-start gap-1.5 text-[13px] leading-snug text-destructive-text">
              <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              {c.noteErrorTooLong}
            </p>
          )}
        </div>

        <p className="text-[13px] leading-[1.45] text-muted-foreground">
          {c.privacyNotice}
          <a href="/privacy" target="_blank" rel="noopener" className="landing-link whitespace-nowrap underline underline-offset-3">
            {c.privacyLink}
            <span className="sr-only">{c.privacyLinkNewTab}</span>
          </a>
        </p>

        <div className="-mt-1 flex flex-col gap-2 min-[400px]:flex-row-reverse min-[400px]:justify-start">
          <Button
            ref={submitRef}
            type="submit"
            disabled={pending}
            focusableWhenDisabled
            className="h-11 max-[399px]:w-full min-[400px]:h-8 pointer-coarse:h-11"
          >
            {/* Always rendered so the idle and pending widths match (design-spec r2 Loading). */}
            <FormSpinner data-slot="submit-spinner" className={pending ? undefined : "invisible"} />
            <span className="grid">
              <span className={pending ? "invisible [grid-area:1/1]" : "[grid-area:1/1]"}>{c.submit}</span>
              <span className={pending ? "[grid-area:1/1]" : "invisible [grid-area:1/1]"} aria-hidden={!pending}>
                {c.submitPending}
              </span>
            </span>
          </Button>
          <DialogClose render={<Button variant="ghost" className="h-11 max-[399px]:w-full min-[400px]:h-8 pointer-coarse:h-11" />}>
            {c.cancel}
          </DialogClose>
        </div>

        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor={ids.honeypot}>{c.honeypotLabel}</label>
          <input ref={honeypotRef} id={ids.honeypot} name={ACCESS_REQUEST_HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
      </form>

      <div
        className="request-swap flex flex-col items-center justify-center px-6 py-8 text-center [grid-area:1/1] data-[hidden]:invisible data-[hidden]:opacity-0"
        data-hidden={!done || undefined}
        aria-hidden={!done || undefined}
        inert={!done || undefined}
      >
        {done && (
          <>
            <CircleCheck aria-hidden="true" className="size-5 text-success-text" />
            <p className="mt-3 text-base font-semibold">{c.successHeading}</p>
            <DialogDescription className="mt-1 max-w-[32ch] text-sm text-muted-foreground">{c.successBody}</DialogDescription>
            <DialogClose ref={closeRef} render={<Button variant="outline" className="mt-5" />}>
              {c.successClose}
            </DialogClose>
          </>
        )}
      </div>
    </div>
  )
}
