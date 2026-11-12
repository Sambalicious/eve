import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { Check, Circle, Copy, Info, LoaderCircle, Mail, PenLine, RotateCw } from "lucide-react"
import { cn } from "cn"

import type { OutreachItem, OutreachKind } from "@eve/contracts"
import { applicationCopy } from "@/entities/application"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button, buttonVariants } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { SectionNote } from "@/shared/ui/section"
import { Textarea } from "@/shared/ui/textarea"
import { kindLabel, kindLower, outreachCopy } from "../model/outreach-copy"
import {
  causeNotice,
  COPIED_MS,
  countLine,
  mailtoHref,
  noticeAnnouncement,
  staleLine,
  writtenLine,
  type CauseNotice,
  type PauseKind,
} from "../model/outreach-state"
import type { SaveNameResult, WriteResult } from "../model/use-outreach-actions"
import { OutreachNotice, OutreachPauseNote } from "./outreach-notice"

export interface OutreachPanelProps {
  item: OutreachItem
  roleTitle: string | null
  company: string | null
  approvedProfileVersion: number | null
  pause: PauseKind | null
  pending: "name" | "write" | undefined
  announce: (message: string) => void
  onWrite: (kind: OutreachKind, item: OutreachItem, draft: string) => Promise<WriteResult>
  onSaveName: (kind: OutreachKind, draft: string) => Promise<SaveNameResult>
  onRefetch: () => void
  onUnavailable: () => void
}

type FieldProblem = "refused" | "saveFailed"

/**
 * One kind's composer (design-spec.r1 section 2 blueprint): purpose, Reader
 * name form, use row, writing line, text or empty fill, meta, link note, stale
 * line, notice, then Write or Write again.
 */
export function OutreachPanel({
  item,
  roleTitle,
  company,
  approvedProfileVersion,
  pause,
  pending,
  announce,
  onWrite,
  onSaveName,
  onRefetch,
  onUnavailable,
}: OutreachPanelProps) {
  const id = useId()
  const kind = item.kind
  const lower = kindLower(kind)
  const label = kindLabel(kind)
  const copy = outreachCopy.kinds[kind]
  const [draft, setDraft] = useState(item.readerName ?? "")
  const [fieldProblem, setFieldProblem] = useState<FieldProblem | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  /**
   * `C-OM-29` inline for a request that never started (offline, 5xx). Not
   * stored: it is shown only while the item still matches what it was before the
   * attempt, so a Run that did start replaces it with the read's own state.
   */
  const [startFailure, setStartFailure] = useState<{ notice: CauseNotice; writtenAt: string | null } | null>(null)
  /** The text date before this visit's Write, so 6.2 can tell Ready from stopped-with-no-cause. */
  const [runBaseline, setRunBaseline] = useState<{ writtenAt: string | null } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const saved = item.readerName ?? ""
  const dirty = draft !== saved
  const writing = item.status === "running" || pending === "write"
  const text = item.text
  /**
   * 6.2: the item returned to idle with nothing written, no cause and no pause.
   * A pause leaves no cause, so the note is derived; if even that is absent the
   * start is unaccounted for and `C-OM-29` stands in. Derived, never stored.
   */
  const stopped =
    runBaseline !== null &&
    item.status === "idle" &&
    item.writtenAt === runBaseline.writtenAt &&
    item.lastFailure === null &&
    pause === null
      ? {
          line: outreachCopy.cause.other(lower),
          earlierKept: item.text === null ? undefined : outreachCopy.cause.earlierKept(lower),
        }
      : null
  const startFailureNotice =
    startFailure !== null &&
    item.status !== "running" &&
    item.lastFailure === null &&
    item.writtenAt === startFailure.writtenAt
      ? startFailure.notice
      : null
  const notice = causeNotice(item) ?? stopped ?? startFailureNotice
  const stale = staleLine(item, approvedProfileVersion)
  const count = countLine(item)
  const written = writtenLine(item)
  /**
   * `C-OM-39`, "Profile version {n}" and `C-OM-40`, in that order. Each part
   * carries the separator that precedes it, so an absent part (no version, no
   * date) leaves no dangling "·" (design review G5).
   */
  const metaParts = [
    count === null ? null : <span>{count}</span>,
    item.profileVersion === null ? null : <span>{applicationCopy.profileVersion(item.profileVersion)}</span>,
    written === null || item.writtenAt === null ? null : (
      <span>
        <WrittenDate written={written} writtenAt={item.writtenAt} />
      </span>
    ),
  ].filter((part) => part !== null)
  const href = mailtoHref(item, roleTitle, company)

  const hintId = `${id}-hint`
  const unsavedId = `${id}-unsaved`
  const problemId = `${id}-problem`

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  /**
   * The outcome of a Run is read from the poll that returns the item to idle
   * (api-contract.md 6.2): a new date is Ready, a cause is spoken, a pause is
   * the note's own announcement, and neither means the start was unaccounted
   * for. Announcements only, so this effect owns no view state.
   */
  const previous = useRef<{ status: OutreachItem["status"]; writtenAt: string | null } | null>(null)
  useEffect(() => {
    const before = previous.current
    previous.current = { status: item.status, writtenAt: item.writtenAt }
    if (before === null || before.status !== "running" || item.status !== "idle") return
    if (item.writtenAt !== before.writtenAt) {
      announce(outreachCopy.writtenAnnounce(lower))
      return
    }
    if (item.lastFailure !== null) {
      const ended = causeNotice(item)
      if (ended) announce(noticeAnnouncement(ended))
      return
    }
    if (pause !== null) return
    const line = outreachCopy.cause.other(lower)
    const earlierKept = item.text === null ? undefined : outreachCopy.cause.earlierKept(lower)
    announce(earlierKept === undefined ? line : `${line} ${earlierKept}`)
  }, [item, pause, announce, lower])

  const saveName = async (event: FormEvent) => {
    event.preventDefault()
    // AC 5.5: the name stays savable while a Run is in flight for the same kind.
    if (pending !== undefined || !dirty) return
    setFieldProblem(null)
    const result = await onSaveName(kind, draft)
    if (result.ok) {
      setDraft(result.item.readerName ?? "")
      announce(result.item.readerName === null ? outreachCopy.name.clearedAnnounce : outreachCopy.name.savedAnnounce)
      return
    }
    if (result.reason === "unavailable") return onUnavailable()
    setFieldProblem(result.reason)
    inputRef.current?.focus()
  }

  const write = async () => {
    if (writing || pause !== null) return
    setFieldProblem(null)
    setStartFailure(null)
    const result = await onWrite(kind, item, draft)
    if (result.ok) {
      setRunBaseline({ writtenAt: item.writtenAt })
      return
    }
    if (result.reason === "unavailable") return onUnavailable()
    if (result.reason === "nameRefused") {
      setFieldProblem("refused")
      inputRef.current?.focus()
      return
    }
    if (result.reason === "nameSaveFailed") {
      setFieldProblem("saveFailed")
      inputRef.current?.focus()
      return
    }
    // A failed start is not stored: C-OM-29 inline, then the read says whether a Run began.
    const line = outreachCopy.cause.other(lower)
    const earlierKept = text === null ? undefined : outreachCopy.cause.earlierKept(lower)
    setStartFailure({ notice: { line, earlierKept }, writtenAt: item.writtenAt })
    announce(earlierKept === undefined ? line : `${line} ${earlierKept}`)
    onRefetch()
  }

  const copyText = async () => {
    if (dirty || text === null) return
    try {
      if (navigator.clipboard === undefined) throw new Error("no clipboard")
      await navigator.clipboard.writeText(text)
      setCopyFailed(false)
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
      announce(outreachCopy.copiedAnnounce(label))
    } catch {
      setCopied(false)
      setCopyFailed(true)
      textRef.current?.focus()
      textRef.current?.select()
    }
  }

  // `C-OM-47` guards Copy and Open in email, which exist only with a Ready text,
  // so the hint shows only then (CURRENT.md decision on the Copywriter's G3 note).
  const unsaved = dirty && text !== null
  const describedBy = [hintId, unsaved ? unsavedId : null, fieldProblem !== null ? problemId : null].filter(Boolean).join(" ")

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{copy.purpose}</p>

      <form noValidate onSubmit={saveName} className="flex flex-col gap-2">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-name`}>{outreachCopy.name.label}</FieldLabel>
          <div className="flex max-w-[72ch] flex-wrap items-center gap-2">
            <Input
              ref={inputRef}
              id={`${id}-name`}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                if (fieldProblem !== null) setFieldProblem(null)
              }}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="words"
              dir="auto"
              aria-describedby={describedBy}
              aria-invalid={fieldProblem === "refused" ? true : undefined}
              className="w-48 min-w-0 flex-1"
            />
            {/*
              `focusableWhenDisabled` keeps focus on the control (design spec
              12) and still gives it the house dim through `data-disabled`: a
              hand-set `aria-disabled` alone renders like an enabled button
              (design review F2).
            */}
            <Button type="submit" variant="outline" size="sm" disabled={!dirty || pending === "name"} focusableWhenDisabled>
              {pending === "name" && <ButtonSpinner />}
              {pending === "name" ? outreachCopy.name.saving : outreachCopy.name.save}
            </Button>
          </div>
          <FieldDescription id={hintId}>{outreachCopy.name.hint}</FieldDescription>
          {unsaved && (
            <FieldDescription id={unsavedId} className="flex items-center gap-1.5">
              <Info aria-hidden="true" className="size-4 shrink-0" />
              {outreachCopy.name.unsaved}
            </FieldDescription>
          )}
          {fieldProblem !== null && (
            <FieldError id={problemId}>
              {fieldProblem === "refused" ? outreachCopy.name.refused : outreachCopy.name.saveFailed}
            </FieldError>
          )}
        </div>
      </form>

      {text !== null && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={dirty}
              focusableWhenDisabled
              aria-describedby={dirty ? unsavedId : undefined}
              onClick={() => void copyText()}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? outreachCopy.copied : outreachCopy.copy}
              <span className="sr-only">, {lower}</span>
            </Button>
            {href === null ? (
              <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Info aria-hidden="true" className="size-4 shrink-0" />
                {outreachCopy.linkTooLong}
              </p>
            ) : (
              <a
                href={dirty ? undefined : href}
                role="link"
                aria-disabled={dirty || undefined}
                aria-describedby={dirty ? unsavedId : undefined}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), dirty && "pointer-events-none opacity-50")}
              >
                <Mail aria-hidden="true" />
                {outreachCopy.openInEmail}
                <span className="sr-only">, {lower}</span>
              </a>
            )}
          </div>
          {copyFailed && (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive-text">
              <Info aria-hidden="true" className="size-4 shrink-0" />
              {outreachCopy.copyFailed}
            </p>
          )}
        </div>
      )}

      {writing && (
        <p role="status" aria-live="polite" className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
          <span className="text-pretty">{outreachCopy.writing(lower)}</span>
        </p>
      )}

      {text !== null ? (
        <>
          <Textarea
            ref={textRef}
            readOnly
            value={text}
            aria-label={outreachCopy.textLabel(lower)}
            dir="auto"
            className="max-w-[72ch] min-h-0 resize-none rounded-xl border-0 bg-muted/60 px-4 py-3.5 text-sm leading-normal text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 forced-colors:border"
          />
          <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] leading-relaxed text-muted-foreground tabular-nums">
            {metaParts.map((part, index) => (
              <span key={index} className="inline-flex items-center gap-x-1.5">
                {index > 0 && <span aria-hidden="true">·</span>}
                {part}
              </span>
            ))}
          </p>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{outreachCopy.linkNote}</p>
          {stale !== null && (
            <p className="flex items-start gap-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="text-pretty">{stale}</span>
            </p>
          )}
        </>
      ) : (
        !writing && notice === null && (
          <SectionNote className="flex items-center gap-2 text-muted-foreground">
            <Circle aria-hidden="true" className="size-4 shrink-0" />
            <span>{outreachCopy.empty}</span>
          </SectionNote>
        )
      )}

      {/*
        The pause note sits above a stored notice, never in place of it
        (`outreach-pause-and-cost.feature`, D13): a Write refused by a pause claims
        no row, so an earlier blocked cause and its quote are still stored and
        still shown.
      */}
      {!writing && pause !== null && <OutreachPauseNote pause={pause} kind={kind} />}
      {!writing && notice !== null && <OutreachNotice notice={notice} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5"
          disabled={writing || pause !== null}
          focusableWhenDisabled
          onClick={() => void write()}
        >
          {writing ? (
            <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
          ) : text === null ? (
            <PenLine aria-hidden="true" />
          ) : (
            <RotateCw aria-hidden="true" />
          )}
          {writing ? outreachCopy.writingButton : text === null ? outreachCopy.write : outreachCopy.writeAgain}
          <span className="sr-only">, {lower}</span>
        </Button>
      </div>
    </div>
  )
}

/** `C-OM-40`: the deck's `Written {date}`, with the date alone in `<time>`. */
function WrittenDate({ written, writtenAt }: { written: string; writtenAt: string }) {
  const date = formatWatDate(writtenAt)
  const at = written.indexOf(date)
  if (at < 0) return <>{written}</>
  return (
    <>
      {written.slice(0, at)}
      <time dateTime={writtenAt}>{date}</time>
      {written.slice(at + date.length)}
    </>
  )
}
