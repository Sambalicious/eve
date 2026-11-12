import { useId, useRef, useState, type FormEvent } from "react"
import { CircleAlert } from "lucide-react"

import {
  isTechnologyCriterionOn,
  type JobCriteria,
  type JobCriteriaListName,
  type SeniorityFloor,
  type TargetRoleFamily,
} from "@/entities/candidate-settings"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group"
import { Section } from "@/shared/ui/section"
import { jobCriteriaCopy } from "../model/copy"
import {
  checkFamilies,
  checkNewEntry,
  LIST_NAMES,
  mapServerFieldErrors,
  NO_SERVER_ERRORS,
  parseMinCoreMatch,
  type Lists,
  type ServerFieldErrors,
} from "../model/criteria-form"
import { useSaveJobCriteria, type SaveFailure } from "../model/use-save-job-criteria"
import { CriteriaListField, type ListEntry } from "./criteria-list-field"
import { RoleFamiliesField } from "./role-families-field"
import { SeniorityField } from "./seniority-field"

type ByList<T> = Record<JobCriteriaListName, T>

/** Chip keys only need to be unique on the page, so one module counter serves every form instance. */
let lastChipKey = 0
const nextChipKey = () => ++lastChipKey
const toEntries = (values: readonly string[]): ListEntry[] => values.map((value) => ({ key: nextChipKey(), value }))

/** The save alert above the button: an API message, C-JC-SAVE-ERR-NET, or the defensive 409 (design-spec J2, J4). */
type SaveAlert = { readonly kind: "message" | "conflict"; readonly message: string }

/**
 * Settings, "Job criteria" (`#job-criteria`, EPIC-0006 design-spec.r1 B1): Role
 * families and Seniority first (they decide what reaches the board), then the
 * minimum core Match, the Frameworks and Technologies chip lists, and one
 * "Save changes" that sends all five fields. Lists are checked as entries are
 * added, the Match field and the families on Save. Every value stays on screen
 * when a save fails.
 */
export function JobCriteriaForm({ criteria }: { criteria: JobCriteria }) {
  const id = useId()

  const [families, setFamilies] = useState<TargetRoleFamily[]>(() => [...criteria.targetRoleFamilies])
  const [familiesError, setFamiliesError] = useState<string | null>(null)
  const [seniorityFloor, setSeniorityFloor] = useState<SeniorityFloor>(criteria.seniorityFloor)
  const [matchText, setMatchText] = useState(String(criteria.minCoreMatchPercent))
  const [matchError, setMatchError] = useState<string | null>(null)
  const [entries, setEntries] = useState<ByList<ListEntry[]>>(() => ({
    frameworks: toEntries(criteria.frameworks),
    technologies: toEntries(criteria.technologies),
  }))
  const [pending, setPending] = useState<ByList<string>>({ frameworks: "", technologies: "" })
  const [entryErrors, setEntryErrors] = useState<ByList<string | null>>({ frameworks: null, technologies: null })
  const [serverErrors, setServerErrors] = useState<ServerFieldErrors>(NO_SERVER_ERRORS)
  const [saveAlert, setSaveAlert] = useState<SaveAlert | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const { save, isSaving, reload } = useSaveJobCriteria()

  const matchRef = useRef<HTMLInputElement>(null)
  const firstFamilyRef = useRef<HTMLButtonElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const inputRefs = useRef<ByList<HTMLInputElement | null>>({ frameworks: null, technologies: null })
  const removeRefs = useRef<ByList<(HTMLButtonElement | null)[]>>({ frameworks: [], technologies: [] })

  const values = (from: ByList<ListEntry[]>): Lists => ({
    frameworks: from.frameworks.map((e) => e.value),
    technologies: from.technologies.map((e) => e.value),
  })
  const label = (list: JobCriteriaListName) => jobCriteriaCopy.listLabel[list]
  const afterRender = (focus: () => void) => requestAnimationFrame(focus)

  const resetFrom = (next: JobCriteria) => {
    setFamilies([...next.targetRoleFamilies])
    setFamiliesError(null)
    setSeniorityFloor(next.seniorityFloor)
    setMatchText(String(next.minCoreMatchPercent))
    setMatchError(null)
    setEntries({ frameworks: toEntries(next.frameworks), technologies: toEntries(next.technologies) })
    setPending({ frameworks: "", technologies: "" })
    setEntryErrors({ frameworks: null, technologies: null })
    setServerErrors(NO_SERVER_ERRORS)
  }

  const clearListServerErrors = (list: JobCriteriaListName) =>
    setServerErrors((current) => ({ ...current, lists: { ...current.lists, [list]: NO_SERVER_ERRORS.lists[list] } }))

  const add = (list: JobCriteriaListName) => {
    const result = checkNewEntry(pending[list], list, values(entries))
    if (!result.ok) {
      setEntryErrors((current) => ({ ...current, [list]: result.error }))
      return
    }
    const count = entries[list].length + 1
    setEntries((current) => ({ ...current, [list]: [...current[list], { key: nextChipKey(), value: result.entry }] }))
    setPending((current) => ({ ...current, [list]: "" }))
    setEntryErrors((current) => ({ ...current, [list]: null }))
    clearListServerErrors(list)
    setAnnouncement(jobCriteriaCopy.liveAdded(result.entry, label(list), count))
  }

  const remove = (list: JobCriteriaListName, index: number) => {
    if (isSaving) return
    const removed = entries[list][index]
    if (!removed) return
    const remaining = entries[list].length - 1
    setEntries((current) => ({ ...current, [list]: current[list].filter((_, i) => i !== index) }))
    clearListServerErrors(list)
    setAnnouncement(jobCriteriaCopy.liveRemoved(removed.value, label(list), remaining))
    // Next chip, else the previous one, else the list's input (design-spec Accessibility).
    afterRender(() => {
      const buttons = removeRefs.current[list]
      ;(buttons[index] ?? buttons[index - 1] ?? inputRefs.current[list])?.focus()
    })
  }

  const showFailure = (failure: SaveFailure, sent: Lists) => {
    if (failure.kind === "signed_out") return
    if (failure.kind === "fields") {
      const mapped = mapServerFieldErrors(failure.fieldErrors, sent)
      if (mapped) {
        setServerErrors(mapped)
        afterRender(() => focusFirstServerError(mapped))
        return
      }
    }
    setSaveAlert({ kind: failure.kind === "conflict" ? "conflict" : "message", message: failure.message })
    afterRender(() => alertRef.current?.focus())
  }

  const focusFirstServerError = (mapped: ServerFieldErrors) => {
    if (mapped.families) return firstFamilyRef.current?.focus()
    if (mapped.match) return matchRef.current?.focus()
    for (const list of LIST_NAMES) {
      const first = [...mapped.lists[list].entries.keys()].sort((a, b) => a - b)[0]
      if (first !== undefined) return removeRefs.current[list][first]?.focus()
      if (mapped.lists[list].list) return inputRefs.current[list]?.focus()
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isSaving) return
    setSaveAlert(null)
    setServerErrors(NO_SERVER_ERRORS)

    const familyProblem = checkFamilies(families)
    setFamiliesError(familyProblem)
    const match = parseMinCoreMatch(matchText)
    setMatchError(match.ok ? null : match.error)

    // Pending text is added under the same rules, never dropped (design-spec J3).
    let next = entries
    let firstBadList: JobCriteriaListName | null = null
    const nextErrors: ByList<string | null> = { ...entryErrors }
    for (const list of LIST_NAMES) {
      if (pending[list].trim() === "") continue
      const result = checkNewEntry(pending[list], list, values(next))
      if (result.ok) {
        next = { ...next, [list]: [...next[list], { key: nextChipKey(), value: result.entry }] }
        nextErrors[list] = null
        setPending((current) => ({ ...current, [list]: "" }))
      } else {
        nextErrors[list] = result.error
        firstBadList ??= list
      }
    }
    setEntries(next)
    setEntryErrors(nextErrors)

    // Families come first in the section, so their refusal takes focus first (design-spec.r1 J2 step 2).
    if (familyProblem) return firstFamilyRef.current?.focus()
    if (!match.ok) return matchRef.current?.focus()
    if (firstBadList) return inputRefs.current[firstBadList]?.focus()

    const sent = values(next)
    save(
      {
        minCoreMatchPercent: match.value,
        frameworks: sent.frameworks,
        technologies: sent.technologies,
        targetRoleFamilies: families,
        seniorityFloor,
      },
      { onSaved: resetFrom, onFailed: (failure) => showFailure(failure, sent) }
    )
  }

  const onReload = async () => {
    const fresh = await reload()
    resetFrom(fresh)
    setSaveAlert(null)
  }

  const matchInvalid = matchError !== null || serverErrors.match !== null
  const matchMessage = matchError ?? serverErrors.match
  const technologyOff = !isTechnologyCriterionOn(values(entries))

  return (
    <Section
      id="job-criteria"
      title={jobCriteriaCopy.title}
      description={jobCriteriaCopy.description}
      layout="split"
      headingProps={{ id: `${id}-heading`, tabIndex: -1 }}
    >
      <form noValidate onSubmit={submit} aria-busy={isSaving} className="flex flex-col gap-6">
        <RoleFamiliesField
          selected={families}
          error={familiesError ?? serverErrors.families}
          isSaving={isSaving}
          firstCheckboxRef={firstFamilyRef}
          onChange={(next) => {
            setFamilies(next)
            // Once shown, the refusal re-validates on every change (design-spec.r1 J2 step 3).
            if (familiesError) setFamiliesError(checkFamilies(next))
            if (serverErrors.families) setServerErrors((current) => ({ ...current, families: null }))
          }}
        />
        <SeniorityField value={seniorityFloor} isSaving={isSaving} onChange={setSeniorityFloor} />
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-match`}>{jobCriteriaCopy.matchLabel}</FieldLabel>
          <InputGroup className="w-28">
            <InputGroupInput
              ref={matchRef}
              id={`${id}-match`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="tabular-nums"
              value={matchText}
              readOnly={isSaving}
              aria-invalid={matchInvalid ? true : undefined}
              aria-describedby={`${id}-match-help${matchInvalid ? ` ${id}-match-error` : ""}`}
              onChange={(event) => {
                const text = event.target.value
                setMatchText(text)
                if (matchError) {
                  const result = parseMinCoreMatch(text)
                  setMatchError(result.ok ? null : result.error)
                }
                if (serverErrors.match) setServerErrors((current) => ({ ...current, match: null }))
              }}
            />
            <InputGroupAddon align="inline-end" aria-hidden="true">
              {jobCriteriaCopy.matchSuffix}
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription id={`${id}-match-help`}>{jobCriteriaCopy.matchHelp}</FieldDescription>
          {matchMessage && (
            <FieldError id={`${id}-match-error`} className="flex items-start gap-1.5">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {matchMessage}
            </FieldError>
          )}
        </div>
        {LIST_NAMES.map((list) => (
          <CriteriaListField
            key={list}
            name={list}
            entries={entries[list]}
            pending={pending[list]}
            entryError={entryErrors[list]}
            serverErrors={serverErrors.lists[list]}
            note={list === "technologies" && technologyOff ? jobCriteriaCopy.technologyOff : undefined}
            isSaving={isSaving}
            inputRef={(element) => {
              inputRefs.current[list] = element
            }}
            removeRef={(index, element) => {
              removeRefs.current[list][index] = element
            }}
            onPendingChange={(value) => {
              setPending((current) => ({ ...current, [list]: value }))
              if (entryErrors[list]) setEntryErrors((current) => ({ ...current, [list]: null }))
            }}
            onAdd={() => add(list)}
            onRemove={(index) => remove(list, index)}
            onBackspaceEmpty={() => removeRefs.current[list][entries[list].length - 1]?.focus()}
            onClearError={() => setEntryErrors((current) => ({ ...current, [list]: null }))}
          />
        ))}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
        <div className="flex flex-col gap-3">
          {saveAlert && (
            <Alert ref={alertRef} tabIndex={-1} variant="destructive" className="outline-none">
              <CircleAlert aria-hidden="true" />
              <AlertTitle className="font-normal [overflow-wrap:anywhere]">{saveAlert.message}</AlertTitle>
              {saveAlert.kind === "conflict" && (
                <div className="col-start-2 mt-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void onReload()}>
                    {jobCriteriaCopy.conflictAction}
                  </Button>
                </div>
              )}
            </Alert>
          )}
          <p className="text-[0.8125rem] leading-[1.45] text-muted-foreground">{jobCriteriaCopy.saveScope}</p>
          <div>
            <Button type="submit" className="w-full sm:w-auto" aria-busy={isSaving} disabled={isSaving} focusableWhenDisabled>
              {isSaving && <ButtonSpinner />}
              {isSaving ? jobCriteriaCopy.saving : jobCriteriaCopy.save}
            </Button>
          </div>
        </div>
      </form>
    </Section>
  )
}
