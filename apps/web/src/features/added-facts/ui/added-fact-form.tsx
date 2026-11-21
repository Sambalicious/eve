import { CircleAlert } from "lucide-react"
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { Link } from "react-router-dom"

import type { AddedFact, AddedFactFieldError, AddedFactProblem, AddedFactRoleOption, AddAddedFactsResponse, AddedFactsView } from "@eve/contracts"

import type { AddedFactsFailure, AddedFactsResult } from "../model/added-facts-actions"
import { addedFactsCopy, atsAddedCopy, roleOptionLabel } from "../model/copy"
import { Button } from "@/shared/ui/button"
import { Checkbox } from "@/shared/ui/checkbox"
import { NativeSelect } from "@/shared/ui/native-select"
import { Textarea } from "@/shared/ui/textarea"

export type AddedFactFormMode =
  | Readonly<{ kind: "add"; helperTerm: string | null }>
  | Readonly<{ kind: "addSentence"; fact: AddedFact }>
  | Readonly<{ kind: "edit"; fact: AddedFact }>

export type AddedFactFormValues = Readonly<{
  text: string
  roleSectionId: string | null
  affirmed: boolean
  saveToProfile: boolean
}>

type SubmitOutcome = AddedFactsResult<AddAddedFactsResponse | AddedFactsView>

type Field = "text" | "roleSectionId" | "affirmed"

type Props = Readonly<{
  mode: AddedFactFormMode
  roles: readonly AddedFactRoleOption[]
  isSaving: boolean
  /** The alert's entry focuses the sentence field once the form is in the DOM (design spec, blueprint 4). */
  autoFocus?: boolean
  onSubmit: (values: AddedFactFormValues) => Promise<SubmitOutcome>
  onCancel: () => void
}>

/**
 * The one inline form (design-spec.r1 blueprint 3): "Add a fact", "Add a sentence" on a skill-only
 * fact, and "Edit" a one-liner. Never a dialog. The server decides every rule; this maps its field
 * errors under the fields (C-AF-50 to C-AF-56, C-AF-59) and keeps the typed text.
 */
export function AddedFactForm({ mode, roles, isSaving, autoFocus = false, onSubmit, onCancel }: Props) {
  const id = useId()
  const fact = mode.kind === "add" ? null : mode.fact
  const initialText = mode.kind === "edit" ? mode.fact.text : ""
  const initialRole = fact?.role?.sectionId ?? ""
  const [text, setText] = useState(initialText)
  const [roleSectionId, setRoleSectionId] = useState(initialRole)
  const [affirmed, setAffirmed] = useState(false)
  const [saveToProfile, setSaveToProfile] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<Readonly<{ text: string; retry: boolean }> | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const roleRef = useRef<HTMLSelectElement>(null)
  const affirmRef = useRef<HTMLButtonElement>(null)
  const profileLinkRef = useRef<HTMLAnchorElement>(null)
  const noRole = roles.length === 0

  // The no-role form renders no text field: the link to the Career Profile is its first control, so
  // that is where the auto-focus (the alert's entry, "Add a fact") lands (design review [6b] note).
  useEffect(() => {
    if (!autoFocus) return
    if (noRole) profileLinkRef.current?.focus()
    else textRef.current?.focus()
  }, [autoFocus, noRole])

  const title = mode.kind === "edit" ? addedFactsCopy.form.titleEdit : mode.kind === "addSentence" ? addedFactsCopy.form.titleAddSentence : addedFactsCopy.form.titleAdd
  const regionLabel = mode.kind === "edit" ? addedFactsCopy.form.regionLabel.edit : mode.kind === "addSentence" ? addedFactsCopy.form.regionLabel.addSentence : addedFactsCopy.form.regionLabel.add
  const count = [...text].length
  const showsAffirmation = mode.kind === "add"
  const showsSaveToProfile = mode.kind === "add"
  const helper = mode.kind === "add" && mode.helperTerm !== null ? addedFactsCopy.form.helperFromAlert(mode.helperTerm) : addedFactsCopy.form.helper
  const term = fact?.term ?? null

  function clearField(field: Field) {
    setFieldErrors((current) => {
      if (current[field] === undefined) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSaving) return
    setFormError(null)
    setFieldErrors({})
    const outcome = await onSubmit({ text, roleSectionId: roleSectionId === "" ? null : roleSectionId, affirmed, saveToProfile })
    if (!outcome.ok) {
      const mapped = mapFailure(outcome.failure, { term, count })
      setFieldErrors(mapped.fields)
      setFormError(mapped.form)
      const first = (["text", "roleSectionId", "affirmed"] as const).find((field) => mapped.fields[field] !== undefined)
      window.requestAnimationFrame(() => {
        if (first === "text") textRef.current?.focus()
        else if (first === "roleSectionId") roleRef.current?.focus()
        else if (first === "affirmed") affirmRef.current?.focus()
      })
      return
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape") return
    // Escape with typed text keeps it and does nothing; otherwise it is Cancel (design spec, form rules).
    if (text !== initialText || roleSectionId !== initialRole) return
    event.stopPropagation()
    onCancel()
  }

  return (
    <form
      aria-label={regionLabel}
      className="flex flex-col gap-3 rounded-xl bg-muted/60 px-4 py-3.5"
      onSubmit={(event) => void submit(event)}
      onKeyDown={onKeyDown}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      {mode.kind === "addSentence" && term !== null && (
        <p className="w-fit rounded-full bg-background px-2 py-0.5 text-[13px] [overflow-wrap:anywhere]">
          {addedFactsCopy.form.about(term)}
        </p>
      )}
      {noRole ? (
        <div className="flex flex-col items-start gap-2 text-[13px]">
          <p className="text-pretty [overflow-wrap:anywhere]">{addedFactsCopy.form.noRole}</p>
          <Link ref={profileLinkRef} to="/profile" className="underline underline-offset-2">
            {addedFactsCopy.form.goToProfile}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-text`} className="text-[13px] font-medium">
              {addedFactsCopy.form.textLabel}
            </label>
            <Textarea
              id={`${id}-text`}
              ref={textRef}
              value={text}
              autoComplete="off"
              spellCheck
              aria-invalid={fieldErrors.text !== undefined || undefined}
              aria-describedby={`${id}-helper${fieldErrors.text === undefined ? "" : ` ${id}-text-error`}`}
              onChange={(event) => {
                setText(event.target.value)
                clearField("text")
              }}
            />
            <p id={`${id}-helper`} className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
              {helper}
            </p>
            {fieldErrors.text !== undefined && (
              <FieldError id={`${id}-text-error`} text={fieldErrors.text} />
            )}
            {count > 0 && <p className="text-[13px] text-muted-foreground tabular-nums">{addedFactsCopy.form.count(count)}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-role`} className="text-[13px] font-medium">
              {addedFactsCopy.form.roleLabel}
            </label>
            <NativeSelect
              id={`${id}-role`}
              ref={roleRef}
              value={roleSectionId}
              aria-invalid={fieldErrors.roleSectionId !== undefined || undefined}
              aria-describedby={fieldErrors.roleSectionId === undefined ? undefined : `${id}-role-error`}
              onChange={(event) => {
                setRoleSectionId(event.target.value)
                clearField("roleSectionId")
              }}
            >
              <option value="" disabled>
                {addedFactsCopy.form.chooseRole}
              </option>
              {roles.map((role) => (
                <option key={role.sectionId} value={role.sectionId}>
                  {roleOptionLabel(role)}
                </option>
              ))}
            </NativeSelect>
            {fieldErrors.roleSectionId !== undefined && <FieldError id={`${id}-role-error`} text={fieldErrors.roleSectionId} />}
          </div>
          {showsAffirmation ? (
            <label className="flex cursor-pointer items-start gap-2.5 py-1 text-[13px]">
              <Checkbox
                ref={affirmRef}
                className="mt-0.5"
                checked={affirmed}
                aria-invalid={fieldErrors.affirmed !== undefined || undefined}
                onCheckedChange={(value) => {
                  setAffirmed(value)
                  clearField("affirmed")
                }}
              />
              <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">{atsAddedCopy.affirmation}</span>
            </label>
          ) : (
            <p className="text-[13px] text-muted-foreground text-pretty">{atsAddedCopy.affirmation}</p>
          )}
          {fieldErrors.affirmed !== undefined && <FieldError text={fieldErrors.affirmed} />}
          {showsSaveToProfile && (
            <label className="flex cursor-pointer items-start gap-2.5 py-1 text-[13px]">
              <Checkbox className="mt-0.5" checked={saveToProfile} onCheckedChange={setSaveToProfile} />
              <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">{atsAddedCopy.saveToProfile}</span>
            </label>
          )}
        </>
      )}
      {formError !== null && (
        <p role="alert" className="flex items-start gap-1.5 text-[13px] text-destructive-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="flex min-w-0 flex-col items-start gap-1">
            <span className="[overflow-wrap:anywhere]">{formError.text}</span>
            {formError.retry && (
              <Button type="submit" variant="outline" size="sm" disabled={isSaving} focusableWhenDisabled>
                {addedFactsCopy.errors.tryAgain}
              </Button>
            )}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!noRole && (
          <Button type="submit" variant="outline" size="sm" disabled={isSaving} focusableWhenDisabled>
            {isSaving
              ? mode.kind === "edit"
                ? addedFactsCopy.form.editSaving
                : addedFactsCopy.form.saving
              : mode.kind === "edit"
                ? addedFactsCopy.form.editSave
                : addedFactsCopy.form.save}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {addedFactsCopy.form.cancel}
        </Button>
      </div>
    </form>
  )
}

function FieldError({ id, text }: { id?: string; text: string }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-[13px] text-destructive-text">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="[overflow-wrap:anywhere]">{text}</span>
    </p>
  )
}

function mapFailure(
  failure: AddedFactsFailure,
  context: Readonly<{ term: string | null; count: number }>
): Readonly<{ fields: Partial<Record<Field, string>>; form: Readonly<{ text: string; retry: boolean }> | null }> {
  if (failure.kind === "fields") {
    const fields: Partial<Record<Field, string>> = {}
    let form: Readonly<{ text: string; retry: boolean }> | null = null
    for (const error of failure.fieldErrors) {
      const target = fieldOf(error, context)
      if (target.field === "form") {
        if (form === null) form = { text: target.text, retry: false }
      } else if (fields[target.field] === undefined) fields[target.field] = target.text
    }
    return { fields, form }
  }
  switch (failure.kind) {
    case "conflict":
      return { fields: {}, form: { text: addedFactsCopy.errors.conflict, retry: false } }
    case "frozen":
      return { fields: {}, form: { text: addedFactsCopy.errors.frozen, retry: false } }
    case "busy":
      return { fields: {}, form: { text: addedFactsCopy.errors.busy, retry: false } }
    case "gone":
      return { fields: {}, form: { text: addedFactsCopy.errors.gone, retry: false } }
    default:
      return { fields: {}, form: { text: addedFactsCopy.errors.network, retry: true } }
  }
}

function fieldOf(
  error: AddedFactFieldError,
  context: Readonly<{ term: string | null; count: number }>
): Readonly<{ field: Field | "form"; text: string }> {
  const problem: AddedFactProblem = error.problem
  switch (problem) {
    case "empty":
      return { field: "text", text: addedFactsCopy.errors.empty }
    case "too_long":
      return { field: "text", text: addedFactsCopy.errors.tooLong(context.count) }
    case "contact_detail":
      return { field: "text", text: addedFactsCopy.errors.contact }
    case "aspiration_text":
      return { field: "text", text: addedFactsCopy.errors.aspiration }
    case "term_not_named":
      return { field: "text", text: addedFactsCopy.errors.mustName(context.term ?? "") }
    case "duplicate":
      return { field: "text", text: addedFactsCopy.errors.duplicate }
    case "invalid_characters":
      return { field: "text", text: addedFactsCopy.errors.characters }
    case "role_required":
    case "role_unknown":
      return { field: "roleSectionId", text: addedFactsCopy.errors.role }
    case "no_experience_role":
      return { field: "form", text: addedFactsCopy.form.noRole }
    case "affirmation_required":
      return { field: "affirmed", text: addedFactsCopy.errors.affirm }
    case "one_liner_limit":
      return { field: "form", text: addedFactsCopy.errors.oneLinerLimit }
    case "skill_only_limit":
      return { field: "form", text: addedFactsCopy.errors.skillCeiling }
    case "term_not_a_gap":
      return { field: "form", text: addedFactsCopy.errors.termNotInList }
    default:
      return { field: "form", text: addedFactsCopy.errors.network }
  }
}
