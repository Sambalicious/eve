import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { ClipboardPaste, Link2, TriangleAlert } from "lucide-react"
import { Link } from "react-router-dom"

import {
  PostingStatusBadge,
  pastedHiddenLine,
  relevanceCopy,
  type HiddenReason,
  type JobPosting,
} from "@/entities/job-posting"
import { hiringCopy as h } from "@/entities/stack-post"
import { useReducedMotion } from "@/shared/lib/use-reduced-motion"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/shared/ui/input-group"
import {
  descriptionLength,
  isDescriptionOverLimit,
  pasteFieldProblems,
  pasteRequestOf,
  type PasteFieldMessages,
  type PasteFields,
} from "../model/description"
import { descriptionResultLine, type DescriptionResultLine } from "../model/description-result"
import { jobLinkProblem } from "../model/job-link"
import { isLinkedInHost } from "../model/linkedin-host"
import { pasteCopy } from "../model/paste-copy"
import { usePasteJobLink, type PasteFormAlert, type PasteOutcome } from "../model/use-paste-job-link"
import { DescriptionPanel } from "./description-panel"

/** C-LINK-2. */
const ALREADY_SAVED = "You already have this Job Posting."
const FADE_IN =
  "animate-in fade-in duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none"
const EMPTY: PasteFields = { link: "", description: "", title: "", company: "" }

/**
 * The places the form is used. All send the same request through
 * `usePasteJobLink`, with the same validation, toasts, C-LINK-2 line and
 * EPIC-0006 B7 hidden line (a created hidden posting shows that line instead
 * of the success toast and, in `check`, instead of the created result line).
 * - `add`: "Add a job link" (Home and `/postings`), its help line under the field.
 * - `check`: Check this job (Hiring view, EPIC-0007 design-spec r1 H4, H5). It
 *   adds the linkedin.com warning (D7), the created result line, a read-only
 *   field while sending, and clears its result lines when the field is edited.
 *   Its help is the section description, linked by `describedBy`.
 *
 * EPIC-0010 design r1 B1: every placement also offers "Add the job description"
 * (closed on load). Open, the panel adds the description, Job title and Company,
 * a standalone send button, the form-level alert, and a result line per
 * `descriptionOutcome`. Closed, the form is exactly today's.
 */
export type PasteJobLinkFormProps = {
  label: string
  /**
   * The visible link label while the panel is open, when `label` is long (the Hiring
   * row's "Application link for {title}"). The full `label` stays the accessible name.
   */
  openLabel?: string
} & (
  | { kind: "add"; help: string }
  | {
      kind: "check"
      describedBy: string
      /**
       * EPIC-0007 design-spec r2 H7 step 3: a Hiring post row's form has an
       * outline submit (Check this job keeps the view's filled button, D9) and
       * takes focus when its panel opens.
       */
      submitVariant?: "default" | "outline"
      autoFocus?: boolean
    }
)

/**
 * - `created`: a visible new posting (`check` only; `add` relies on the toast).
 * - `status`: the line under the field: a known link (C-LINK-2), or (EPIC-0006
 *   B7) a saved link that is hidden, which names the first hidden reason.
 * - `description`: a paste that carried a description (EPIC-0010, both kinds).
 */
type Result =
  | { kind: "created"; posting: JobPosting }
  | {
      kind: "status"
      postingId: string
      created: boolean
      hiddenReason: HiddenReason | null
    }
  | { kind: "description"; line: DescriptionResultLine }

export function PasteJobLinkForm(props: PasteJobLinkFormProps) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const companyRef = useRef<HTMLInputElement>(null)
  const [fields, setFields] = useState<PasteFields>(EMPTY)
  const [open, setOpen] = useState(false)
  /** The closed panel's last values, shown inert while its 150ms exit plays (design r1 Motion). */
  const [exiting, setExiting] = useState<PasteFields | null>(null)
  const reducedMotion = useReducedMotion()
  useEffect(() => {
    if (exiting === null) return
    const timer = setTimeout(() => setExiting(null), 150)
    return () => clearTimeout(timer)
  }, [exiting])
  const [errors, setErrors] = useState<PasteFieldMessages>({})
  const [formAlert, setFormAlert] = useState<PasteFormAlert | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  /** The trimmed linkedin.com value the warning was shown for; sending it again goes ahead (H5 step 3). */
  const [warnedFor, setWarnedFor] = useState<string | null>(null)
  /** Where focus goes after the next render (the element exists only once the panel opened or closed). */
  const focusNext = useRef<"description" | "toggle" | "link" | null>(null)
  const isCheck = props.kind === "check"
  const overLimit = open && isDescriptionOverLimit(fields.description)

  useEffect(() => {
    if (focusNext.current === null) return
    const target = { description: descriptionRef, toggle: toggleRef, link: inputRef }[focusNext.current]
    focusNext.current = null
    target.current?.focus()
  })

  const closePanel = (focus: "toggle" | "link") => {
    // P3: a 150ms exit of a read-only copy; the real panel is gone at once, so focus and state move now.
    if (!reducedMotion) setExiting(fields)
    setFields((current) => ({ ...EMPTY, link: focus === "link" ? "" : current.link }))
    setErrors({})
    setFormAlert(null)
    setOpen(false)
    focusNext.current = focus
  }

  const onDescriptionOutcome = (outcome: PasteOutcome) => {
    if (outcome.kind === "description") {
      const line = descriptionResultLine(outcome.result)
      if (!line) return
      setResult({ kind: "description", line })
      if (line.keepValues) sendRef.current?.focus()
      else closePanel("link")
      return
    }
    if (outcome.kind === "fields") {
      setErrors(outcome.messages)
      focusFirstInvalid(outcome.messages)
      return
    }
    if (outcome.kind === "alert") {
      setFormAlert(outcome.alert)
      if (outcome.alert.kind === "employer_page_unreadable") {
        const first = outcome.alert.missing[0]
        ;(first === "company" ? companyRef : titleRef).current?.focus()
      } else sendRef.current?.focus()
    }
  }

  const { paste, isPasting } = usePasteJobLink({
    onOutcome: (outcome: PasteOutcome) => {
      if (outcome.kind === "description" || outcome.kind === "fields" || outcome.kind === "alert")
        return onDescriptionOutcome(outcome)
      if (outcome.kind === "created") {
        if (open) closePanel("link")
        else setFields(EMPTY)
        const { posting } = outcome
        if (posting.hiddenReason)
          setResult({
            kind: "status",
            postingId: posting.id,
            created: true,
            hiddenReason: posting.hiddenReason,
          })
        else if (isCheck) setResult({ kind: "created", posting })
        if (isCheck) inputRef.current?.focus()
        return
      }
      if (outcome.kind === "existing")
        return setResult({
          kind: "status",
          postingId: outcome.posting.id,
          created: false,
          hiddenReason: outcome.posting.hiddenReason,
        })
      setErrors({ link: outcome.message })
      inputRef.current?.focus()
    },
  })

  const focusFirstInvalid = (messages: PasteFieldMessages) => {
    if (messages.link) return inputRef.current?.focus()
    if (messages.description) return descriptionRef.current?.focus()
    if (messages.title) return titleRef.current?.focus()
    if (messages.company) companyRef.current?.focus()
  }

  const sendLink = (url: string) => {
    setWarnedFor(null)
    paste({ url })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isPasting) return
    // Over the limit the send button is aria-disabled: activating it does nothing (PD:167).
    if (overLimit) return
    setResult(null)
    setFormAlert(null)
    const request = open ? pasteRequestOf(fields) : { url: fields.link.trim() }
    if (open) {
      const problems = pasteFieldProblems(fields)
      setErrors(problems)
      if (Object.keys(problems).length > 0) return focusFirstInvalid(problems)
    } else {
      const problem = jobLinkProblem(fields.link)
      setErrors(problem ? { link: problem } : {})
      if (problem) return inputRef.current?.focus()
    }
    // The linkedin.com warning is for a link-only paste: with a description its claim is no longer true.
    if (!("description" in request)) {
      if (isCheck && isLinkedInHost(request.url) && warnedFor !== request.url) {
        setWarnedFor(request.url)
        inputRef.current?.focus()
        return
      }
      return sendLink(request.url)
    }
    setWarnedFor(null)
    paste(request)
  }

  const edit = (field: keyof PasteFields, next: string) => {
    setFields((current) => ({ ...current, [field]: next }))
    if (open) {
      setFormAlert(null)
      setResult(null)
      // The over-limit error shows live and clears live (design r1 "Over the limit").
      if (field === "description")
        setErrors((current) => {
          const { description, ...rest } = current
          const longMessage = pasteCopy.error.job_description_too_long
          if (isDescriptionOverLimit(next)) return { ...rest, description: longMessage }
          return description === longMessage ? rest : current
        })
    }
    if (!isCheck) return
    setWarnedFor(null)
    setResult(null)
  }

  const openPanel = () => {
    setOpen(true)
    setResult(null)
    setWarnedFor(null)
    focusNext.current = "description"
  }

  const linkError = errors.link
  const describedBy = [
    props.kind === "add" ? `${id}-help` : props.describedBy,
    linkError && `${id}-error`,
    warnedFor && `${id}-warning`,
    result && `${id}-result`,
  ]
    .filter(Boolean)
    .join(" ")
  const submitVariant = props.kind === "check" ? (props.submitVariant ?? "default") : "default"
  const readOnly = (isCheck || open) && isPasting

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-busy={isCheck || open ? isPasting : undefined}
      className="flex flex-col gap-1.5"
    >
      <FieldLabel htmlFor={id} className={open ? undefined : "sr-only"}>
        {open ? (
          <>
            {props.openLabel ? (
              <>
                <span aria-hidden="true">{props.openLabel}</span>
                <span className="sr-only">{props.label}</span>
              </>
            ) : (
              props.label
            )}{" "}
            <span className="font-normal text-muted-foreground">({pasteCopy.optional})</span>
          </>
        ) : (
          props.label
        )}
      </FieldLabel>
      <InputGroup className="h-10 pr-1 pointer-coarse:h-12">
        <InputGroupAddon>
          <Link2 aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          id={id}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://"
          value={fields.link}
          readOnly={readOnly}
          aria-invalid={linkError ? true : undefined}
          aria-describedby={describedBy}
          autoFocus={props.kind === "check" && props.autoFocus}
          onChange={(event) => edit("link", event.target.value)}
        />
        {!open && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="submit"
              variant={submitVariant}
              size="sm"
              className="h-8 rounded-md px-3"
              aria-busy={isPasting}
              disabled={isPasting}
            >
              {isPasting && <ButtonSpinner />}
              {isPasting ? "Checking…" : "Check link"}
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      {linkError && <FieldError id={`${id}-error`}>{linkError}</FieldError>}
      {open ? (
        <div className="mt-3 flex flex-col gap-4">
          <DescriptionPanel
            id={id}
            fields={fields}
            errors={errors}
            count={descriptionLength(fields.description)}
            overLimit={overLimit}
            alert={formAlert}
            readOnly={isPasting}
            descriptionRef={descriptionRef}
            titleRef={titleRef}
            companyRef={companyRef}
            onEdit={edit}
            onRemove={() => closePanel("toggle")}
          />
          <div>
            <Button
              ref={sendRef}
              type="submit"
              variant={submitVariant}
              className="w-full sm:w-auto pointer-coarse:h-11"
              aria-busy={isPasting}
              // DR-01, DR-02: focus stays on send while pending and over the limit; data-disabled dims it.
              disabled={isPasting || overLimit}
              focusableWhenDisabled
              aria-describedby={overLimit ? `${id}-description-error` : undefined}
            >
              {isPasting && <ButtonSpinner />}
              {isPasting ? "Checking…" : pasteCopy.submit}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={toggleRef}
          type="button"
          variant="link"
          className="h-auto self-start px-0 py-1 pointer-coarse:min-h-11"
          aria-expanded={false}
          aria-controls={`${id}-panel`}
          onClick={openPanel}
        >
          <ClipboardPaste aria-hidden="true" />
          {pasteCopy.toggle}
        </Button>
      )}
      {exiting && !open && (
        <div aria-hidden="true" inert className="mt-3">
          <DescriptionPanel
            id={`${id}-exit`}
            motion="exit"
            fields={exiting}
            errors={{}}
            count={descriptionLength(exiting.description)}
            overLimit={false}
            alert={null}
            readOnly
            descriptionRef={{ current: null }}
            titleRef={{ current: null }}
            companyRef={{ current: null }}
            onEdit={() => {}}
            onRemove={() => {}}
          />
        </div>
      )}
      {warnedFor && (
        <Alert
          id={`${id}-warning`}
          className={`mt-1 *:[svg]:text-warning-text ${FADE_IN}`}
        >
          <TriangleAlert aria-hidden="true" />
          <AlertTitle className="font-normal text-pretty">
            {h.linkedInWarning}
          </AlertTitle>
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPasting}
              onClick={() => sendLink(warnedFor)}
            >
              {h.linkedInSend}
            </Button>
          </div>
        </Alert>
      )}
      {result?.kind === "created" && (
        <p
          id={`${id}-result`}
          role="status"
          className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${FADE_IN}`}
        >
          <span>{h.checkCreated}</span>
          <PostingStatusBadge posting={result.posting} />
          <Link
            to={`/postings/${result.posting.id}`}
            className="underline underline-offset-4"
          >
            {h.checkView}
          </Link>
        </p>
      )}
      {result?.kind === "description" && (
        <p
          id={`${id}-result`}
          role="status"
          className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm [overflow-wrap:anywhere] ${FADE_IN}`}
        >
          <span>{result.line.text}</span>
          {result.line.badgePosting && <PostingStatusBadge posting={result.line.badgePosting} />}
          <Link to={result.line.link.to} className="underline underline-offset-4">
            {result.line.link.label}
          </Link>
        </p>
      )}
      {result?.kind === "status" && (
        <p
          id={`${id}-result`}
          role="status"
          className="text-sm [overflow-wrap:anywhere]"
        >
          {result.hiddenReason
            ? pastedHiddenLine(result.created, result.hiddenReason)
            : ALREADY_SAVED}{" "}
          <Link
            to={`/postings/${result.postingId}`}
            className="underline underline-offset-4"
          >
            {relevanceCopy.addJobLink.hidden.view}
          </Link>
        </p>
      )}
      {props.kind === "add" && (
        <FieldDescription id={`${id}-help`}>{props.help}</FieldDescription>
      )}
    </form>
  )
}
