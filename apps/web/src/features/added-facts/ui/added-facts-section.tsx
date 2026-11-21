import { CircleAlert, LoaderCircle, Lock, Tag, TextQuote } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import type { AddedFact, AddedFactsView, AddAddedFactsResponse, ProfileSaveOutcome } from "@eve/contracts"

import { Button } from "@/shared/ui/button"
import { Section, SectionNote } from "@/shared/ui/section"

import type { AddedFactsFailure, AddedFactsResult } from "../model/added-facts-actions"
import { addedFactsCopy, atsAddedCopy, roleLabel } from "../model/copy"
import { AddedFactForm, type AddedFactFormValues } from "./added-fact-form"

export type AddedFactsSectionProps = Readonly<{
  view: AddedFactsView | undefined
  /** The blocked alert's "Add a fact about {term}" (C-AF-44): opens free entry with C-AF-41 as its helper. */
  formRequest: Readonly<{ term: string | null; nonce: number }> | null
  isAdding: boolean
  isEditing: boolean
  isRemoving: boolean
  announcement: string
  announce: (text: string) => void
  onAdd: (values: AddedFactFormValues) => Promise<AddedFactsResult<AddAddedFactsResponse>>
  onEdit: (fact: AddedFact, values: Pick<AddedFactFormValues, "text" | "roleSectionId">) => Promise<AddedFactsResult<AddedFactsView>>
  onRemove: (fact: AddedFact) => Promise<AddedFactsResult<AddedFactsView>>
}>

type OpenForm =
  | Readonly<{ kind: "add"; helperTerm: string | null }>
  | Readonly<{ kind: "addSentence"; fact: AddedFact }>
  | Readonly<{ kind: "edit"; fact: AddedFact }>

/**
 * "Added for this job" (design-spec.r1 blueprint 2): the facts this Application holds beyond the
 * Career Profile. Rows carry edit, add a sentence and remove; the one inline form adds or edits. No
 * dialog, no toast: the row moving and one live region are the feedback.
 */
export function AddedFactsSection({
  view,
  formRequest,
  isAdding,
  isEditing,
  isRemoving,
  announcement,
  announce,
  onAdd,
  onEdit,
  onRemove,
}: AddedFactsSectionProps) {
  const [open, setOpen] = useState<OpenForm | null>(null)
  // The control that opened the inline form, so Cancel and Escape can put focus back on it.
  const openerRef = useRef<HTMLElement | null>(null)
  const [dismissedRequest, setDismissedRequest] = useState<number | null>(null)
  const [profileNotes, setProfileNotes] = useState<Readonly<Record<string, string>>>({})
  const [sectionError, setSectionError] = useState<Readonly<{ text: string; retry: AddedFact | null }> | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  // The alert's action: formRequest opens free entry with the term as a helper only. Closing it
  // dismisses that request, so the form does not come back on the next render.
  const alertForm: OpenForm | null =
    formRequest !== null && formRequest.nonce !== dismissedRequest ? { kind: "add", helperTerm: formRequest.term } : null
  const activeForm = open ?? alertForm

  // Scroll and announce once per request; the form itself focuses its field on mount (C-AF-69).
  useEffect(() => {
    if (formRequest === null || formRequest.nonce === dismissedRequest) return
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("added-facts")?.scrollIntoView?.({ block: "start" })
    })
    if (formRequest.term !== null) announce(addedFactsCopy.announce.formOpened(formRequest.term))
    return () => window.cancelAnimationFrame(frame)
  }, [formRequest, dismissedRequest, announce])

  if (view === undefined) return null

  const editable = view.editable
  const facts = view.facts
  const limitReached = view.counts.oneLiner >= view.limits.oneLiner
  const retryFact = sectionError?.retry ?? null

  function closeForm() {
    if (formRequest !== null) setDismissedRequest(formRequest.nonce)
    setOpen(null)
  }

  /**
   * Cancel and Escape close the form and put focus back on the control that opened it (design spec
   * "Focus" and "Interaction patterns"). Save paths keep their own focus target: `focusRow`, or the
   * blocked alert's button. The alert opens the form from outside this component, so its opener is
   * looked up by id.
   */
  function cancelForm() {
    const fromAlert = open === null && alertForm !== null
    const opener = fromAlert ? document.getElementById("document-blocked-add-fact") : openerRef.current
    closeForm()
    window.requestAnimationFrame(() => (opener ?? document.getElementById("added-facts-add"))?.focus())
  }

  function openForm(next: OpenForm, opener: HTMLElement) {
    openerRef.current = opener
    setSectionError(null)
    setOpen(next)
  }

  function focusRow(factId: string | null) {
    window.requestAnimationFrame(() => {
      const target =
        (factId === null ? null : document.querySelector<HTMLElement>(`[data-fact-id="${factId}"] button`)) ??
        document.getElementById("added-facts-add")
      target?.focus()
    })
  }

  function saveNotes(value: AddAddedFactsResponse) {
    const notes: Record<string, string> = {}
    for (const save of value.profileSave) {
      const note = profileNoteOf(save.outcome)
      if (note !== null) notes[save.factId] = note
    }
    setProfileNotes((current) => ({ ...current, ...notes }))
  }

  async function submitAdd(values: AddedFactFormValues) {
    // Opened from the blocked alert: after saving, focus returns to that button (blueprint 4).
    const fromAlert = open === null && alertForm !== null
    const result = await onAdd(values)
    if (result.ok) {
      saveNotes(result.value)
      announce(addedFactsCopy.announce.saved)
      closeForm()
      if (fromAlert) window.requestAnimationFrame(() => document.getElementById("document-blocked-add-fact")?.focus())
      else focusRow(result.value.profileSave[0]?.factId ?? null)
    }
    return result
  }

  async function submitEdit(fact: AddedFact, values: Pick<AddedFactFormValues, "text" | "roleSectionId">) {
    const result = await onEdit(fact, values)
    if (result.ok) {
      announce(addedFactsCopy.announce.saved)
      closeForm()
      focusRow(fact.id)
    }
    return result
  }

  async function remove(fact: AddedFact) {
    if (removingId !== null) return
    setSectionError(null)
    setRemovingId(fact.id)
    const result = await onRemove(fact)
    setRemovingId(null)
    if (result.ok) {
      setProfileNotes((current) => {
        const next = { ...current }
        delete next[fact.id]
        return next
      })
      announce(fact.term === null ? addedFactsCopy.announce.removed : addedFactsCopy.announce.removedTerm(fact.term))
      return
    }
    setSectionError(sectionErrorOf(result.failure, fact))
  }

  return (
    <Section
      id="added-facts"
      title={addedFactsCopy.heading}
      headingProps={{ id: "added-facts-heading", tabIndex: -1 }}
      description={addedFactsCopy.description}
      actions={
        editable ? (
          <Button
            id="added-facts-add"
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:min-h-11"
            onClick={(event) => {
              openForm({ kind: "add", helperTerm: null }, event.currentTarget)
            }}
          >
            {addedFactsCopy.addFact}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted-foreground tabular-nums">{addedFactsCopy.count(view.counts.oneLiner)}</p>
        {limitReached && (
          // Design review [6b] note (C-AF-55): a status region, re-mounted when a form opens, so the
          // line is announced once as the form appears. The key flips only between closed and open.
          <p key={activeForm === null ? "limit" : "limit-form-open"} role="status" className="text-[13px] text-muted-foreground">
            {addedFactsCopy.errors.oneLinerLimit}
          </p>
        )}
        {!editable && (
          <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
            {view.busyReason !== null ? (
              <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
            ) : (
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            )}
            <span>{view.busyReason !== null ? addedFactsCopy.busy : addedFactsCopy.frozen}</span>
          </p>
        )}
        {sectionError !== null && (
          <p role="alert" className="flex items-start gap-1.5 text-[13px] text-destructive-text">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="flex min-w-0 flex-col items-start gap-1">
              <span className="[overflow-wrap:anywhere]">{sectionError.text}</span>
              {retryFact !== null && (
                <Button type="button" variant="outline" size="sm" onClick={() => void remove(retryFact)} disabled={isRemoving} focusableWhenDisabled>
                  {addedFactsCopy.errors.tryAgain}
                </Button>
              )}
            </span>
          </p>
        )}
        {activeForm?.kind === "add" && editable && (
          <AddedFactForm
            key={`add-${activeForm.helperTerm ?? ""}`}
            mode={activeForm}
            roles={view.roles}
            isSaving={isAdding}
            autoFocus
            onSubmit={submitAdd}
            onCancel={cancelForm}
          />
        )}
        {facts.length === 0 && activeForm === null && (
          <SectionNote className="text-[13px] text-muted-foreground">
            {view.postingGaps.available ? addedFactsCopy.emptyWithGaps : addedFactsCopy.emptyNoList}
          </SectionNote>
        )}
        {facts.length > 0 && (
          <ul aria-label={addedFactsCopy.a11y.listLabel} className="flex flex-col">
            {facts.map((fact) => (
              <AddedFactRow
                key={fact.id}
                fact={fact}
                editable={editable}
                hasRole={view.roles.length > 0}
                profileNote={profileNotes[fact.id] ?? null}
                removing={removingId === fact.id}
                form={
                  activeForm !== null && activeForm.kind !== "add" && activeForm.fact.id === fact.id ? (
                    <AddedFactForm
                      key={`${activeForm.kind}-${fact.id}`}
                      mode={activeForm}
                      roles={view.roles}
                      isSaving={isEditing}
                      onSubmit={(values) => submitEdit(fact, values)}
                      onCancel={cancelForm}
                    />
                  ) : null
                }
                onEdit={(opener) => {
                  openForm({ kind: "edit", fact }, opener)
                }}
                onAddSentence={(opener) => {
                  openForm({ kind: "addSentence", fact }, opener)
                }}
                onRemove={() => void remove(fact)}
              />
            ))}
          </ul>
        )}
        {facts.length > 0 && <p className="text-[13px] text-muted-foreground">{addedFactsCopy.outreachNote}</p>}
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </Section>
  )
}

function AddedFactRow({
  fact,
  editable,
  hasRole,
  profileNote,
  removing,
  form,
  onEdit,
  onAddSentence,
  onRemove,
}: Readonly<{
  fact: AddedFact
  editable: boolean
  hasRole: boolean
  profileNote: string | null
  removing: boolean
  form: ReactNode
  onEdit: (opener: HTMLButtonElement) => void
  onAddSentence: (opener: HTMLButtonElement) => void
  onRemove: () => void
}>) {
  const skillOnly = fact.kind === "skill_only"
  const Marker = skillOnly ? Tag : TextQuote
  return (
    <li data-fact-id={fact.id} aria-busy={removing || undefined} className="flex flex-col gap-1 border-b border-border/60 py-3 last:border-b-0">
      <p className="text-sm leading-snug [overflow-wrap:anywhere]">
        <bdi>{fact.text}</bdi>
      </p>
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-muted-foreground">
        <span className="sr-only">{addedFactsCopy.a11y.kind}: </span>
        <span className="inline-flex items-center gap-1">
          <Marker aria-hidden="true" className="size-3.5" />
          <span>{skillOnly ? atsAddedCopy.kind.skillOnly : atsAddedCopy.kind.oneLiner}</span>
        </span>
        {fact.role !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="sr-only">{addedFactsCopy.a11y.role}: </span>
            <span className="[overflow-wrap:anywhere]">{addedFactsCopy.role(roleLabel(fact.role))}</span>
          </>
        )}
        {skillOnly && fact.term !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="[overflow-wrap:anywhere]">{addedFactsCopy.term(fact.term)}</span>
          </>
        )}
      </p>
      <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
        <span>{fact.usedInDocuments ? addedFactsCopy.used : addedFactsCopy.unused}</span>
        {fact.profile !== null && (
          <>
            <span aria-hidden="true"> · </span>
            <span>
              {fact.profile.status === "approved" ? addedFactsCopy.inProfileVersion(fact.profile.version) : addedFactsCopy.inProfileDraft}
            </span>
          </>
        )}
      </p>
      {profileNote !== null && <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{profileNote}</p>}
      {editable && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {skillOnly ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={hasRole ? `${addedFactsCopy.addSentence} about ${fact.term ?? ""}` : `${addedFactsCopy.addSentence}, ${addedFactsCopy.a11y.noRoleReason}`}
                className="pointer-coarse:min-h-11"
                aria-disabled={!hasRole || removing || undefined}
                onClick={hasRole ? (event) => onAddSentence(event.currentTarget) : undefined}
              >
                {addedFactsCopy.addSentence}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${addedFactsCopy.edit}, ${fact.text}`}
                className="pointer-coarse:min-h-11"
                disabled={removing}
                focusableWhenDisabled
                onClick={(event) => onEdit(event.currentTarget)}
              >
                {addedFactsCopy.edit}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${addedFactsCopy.remove}, ${fact.text}`}
              className="pointer-coarse:min-h-11"
              disabled={removing}
              focusableWhenDisabled
              onClick={onRemove}
            >
              {addedFactsCopy.remove}
            </Button>
          </div>
          {fact.saveToProfile && <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{addedFactsCopy.removeProfileNote}</p>}
        </div>
      )}
      {form}
    </li>
  )
}

function profileNoteOf(outcome: ProfileSaveOutcome): string | null {
  switch (outcome) {
    case "draft_full":
      return addedFactsCopy.profilePartial
    case "already_there":
      return addedFactsCopy.profileDuplicate
    case "draft_unavailable":
      return addedFactsCopy.profileDraftUnavailable
    case "failed":
      return addedFactsCopy.profileFailed
    default:
      return null
  }
}

function sectionErrorOf(failure: AddedFactsFailure, fact: AddedFact): Readonly<{ text: string; retry: AddedFact | null }> {
  switch (failure.kind) {
    case "conflict":
      return { text: addedFactsCopy.errors.conflict, retry: null }
    case "frozen":
      return { text: addedFactsCopy.errors.frozen, retry: null }
    case "busy":
      return { text: addedFactsCopy.errors.busy, retry: null }
    case "gone":
      return { text: addedFactsCopy.errors.gone, retry: null }
    default:
      return { text: addedFactsCopy.errors.network, retry: fact }
  }
}
