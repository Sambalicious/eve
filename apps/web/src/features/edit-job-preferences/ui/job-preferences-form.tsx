import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { CircleAlert } from "lucide-react"
import { useBlocker } from "react-router-dom"
import { keywordFoldsToEmpty, type RoleFamilyValue } from "@eve/contracts"

import type { JobPreferences, SavedJobPreferences } from "@/entities/job-preferences"
import { toastSuccess } from "@/shared/lib/action-failed"
import { Alert, AlertAction, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { Section } from "@/shared/ui/section"
import { prefsCopy as c } from "../model/copy"
import { formatSavedAt } from "../model/display"
import {
  changeHomeCountry,
  fieldErrorsFromServer,
  fieldId,
  isDirty,
  toFormState,
  toSaveInput,
  validate,
  type FieldErrors,
  type FieldKey,
  type FormState,
  type HomeChangeNotice,
} from "../model/preferences-form"
import { useSavePreferences, type PreferencesSaveFailure } from "../model/use-save-preferences"
import {
  DailyCapField,
  ExclusionsFields,
  LocationHoursFields,
  PayFields,
  RoleFamiliesFields,
  SeniorityEmploymentFields,
  ThemesField,
  WorkArrangementFields,
} from "./preferences-fields"

/** Labels of each field for the error summary links (link text = field label, C-PREF-SUM). */
const SUMMARY_LABEL: Record<FieldKey, string> = {
  homeCountry: c.home.label,
  timeZone: c.timeZone.label,
  latestWorkHour: c.hour.label,
  workAuthorizedCountries: c.workAuth.label,
  workArrangement: c.arrangement.label,
  sponsorshipNeededForRelocation: c.sponsorship.label,
  excludedRelocationCountries: c.excludedCountries.label,
  excludedIndustries: c.industries.label,
  payFloorAmount: c.pay.floor.label,
  payFloorCurrency: c.pay.floor.currencyLabel,
  payFloorPeriod: c.pay.floor.label,
  preferredPayAmount: c.pay.preferred.label,
  preferredPayCurrency: c.pay.preferred.currencyLabel,
  preferredPayPeriod: c.pay.preferred.label,
  roleFamilyTiers: c.families.title,
  titleKeyword: c.keyword.label,
  seniorityLevels: c.seniority.label,
  employmentTypes: c.employment.label,
  dailyCap: c.cap.label,
  emphasisThemes: c.themes.label,
}

/** The save alert above the primary (B-PREF-3 reading order). */
type SaveAlert =
  | { readonly kind: "network" | "rateLimited" | "wizardError" | "offline" }
  | { readonly kind: "message"; readonly message: string }

export interface JobPreferencesFormProps {
  preferences: JobPreferences
  /** Settings: toast, after-save lines, "Save preferences". Wizard: no toast, `onSaved` advances. */
  mode: "settings" | "wizard"
  /** Today's automatic submissions for `C-PREF-CAP-WARN`; null when unknown. */
  todayCount?: number | null
  onSaved?: (saved: SavedJobPreferences) => void
  /**
   * B1 interim Settings: the families selected on the board (Job criteria). A tier row for
   * any other family shows "Hidden". Display only: never in the dirty check or the request.
   */
  boardFamilies?: readonly RoleFamilyValue[]
}

/**
 * S4 Job Preferences form (design-spec.r4 F4, S4; r6 B-PREF-3), the same component
 * in Settings and wizard step 3. One save sends every value with `baseVersion`.
 * Edits stay on screen through every refusal; nothing is merged on reload.
 */
export function JobPreferencesForm({ preferences, mode, todayCount = null, onSaved, boardFamilies }: JobPreferencesFormProps) {
  const formId = useId().replace(/:/g, "")
  const [loaded, setLoaded] = useState(() => ({ version: preferences.version, state: toFormState(preferences.values) }))
  const [state, setState] = useState<FormState>(loaded.state)
  const [errors, setErrors] = useState<FieldErrors>(new Map())
  const [summaryCount, setSummaryCount] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [saveAlert, setSaveAlert] = useState<SaveAlert | null>(null)
  const [notice, setNotice] = useState<HomeChangeNotice | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [foldedEmpty, setFoldedEmpty] = useState(false)
  const [savedKeyword, setSavedKeyword] = useState(preferences.values.titleKeyword)
  const [matchedRegions, setMatchedRegions] = useState(preferences.matchedRegions)
  const { save, reload, isSaving } = useSavePreferences()

  const summaryRef = useRef<HTMLDivElement>(null)
  const conflictRef = useRef<HTMLDivElement>(null)
  const saveAlertRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const pendingFocus = useRef<"summary" | "conflict" | "saveAlert" | "heading" | null>(null)

  const dirty = isDirty(state, loaded.state)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !isSaving && currentLocation.pathname !== nextLocation.pathname)

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  useEffect(() => {
    const target = pendingFocus.current
    pendingFocus.current = null
    if (target === "summary") summaryRef.current?.focus()
    else if (target === "conflict") conflictRef.current?.focus()
    else if (target === "saveAlert") saveAlertRef.current?.focus()
    else if (target === "heading") sectionHeading(formRef.current)?.focus()
  })

  const update = (patch: Partial<FormState>) => setState((current) => ({ ...current, ...patch }))

  const showFieldErrors = (next: FieldErrors) => {
    setErrors(next)
    setSummaryCount(next.size)
    pendingFocus.current = "summary"
  }

  const onFailed = (failure: PreferencesSaveFailure) => {
    switch (failure.kind) {
      case "signed_out":
        return
      case "fields":
        return showFieldErrors(fieldErrorsFromServer(failure.fieldErrors))
      case "conflict":
        setConflict(true)
        pendingFocus.current = "conflict"
        return
      case "rateLimited":
        setSaveAlert({ kind: "rateLimited" })
        break
      case "message":
        setSaveAlert({ kind: "message", message: failure.message })
        break
      case "network":
        setSaveAlert({ kind: mode === "wizard" ? "wizardError" : "network" })
        break
      case "offline":
        setSaveAlert({ kind: mode === "wizard" ? "offline" : "network" })
        break
    }
    pendingFocus.current = "saveAlert"
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (isSaving) return
    setSaveAlert(null)
    const clientErrors = validate(state)
    if (clientErrors.size > 0) return showFieldErrors(clientErrors)
    setErrors(new Map())
    setSummaryCount(0)
    const typedKeyword = state.titleKeyword.trim()
    save(toSaveInput(state, loaded.version), {
      onSaved: (saved) => {
        const next = toFormState(saved.values)
        setLoaded({ version: saved.version, state: next })
        setState(next)
        setConflict(false)
        setNotice(null)
        setSavedKeyword(saved.values.titleKeyword)
        setMatchedRegions(saved.matchedRegions)
        setFoldedEmpty(typedKeyword !== "" && saved.values.titleKeyword === null && keywordFoldsToEmpty(typedKeyword))
        if (mode === "settings") {
          setSavedAt(formatSavedAt(saved.savedAt, saved.values.timeZone))
          toastSuccess(c.save.saved)
        }
        onSaved?.(saved)
      },
      onFailed,
    })
  }

  const reloadLatest = async () => {
    const latest = await reload()
    // DP-B1-02: the alert (and the focused button) unmounts; land on the form's section heading.
    pendingFocus.current = "heading"
    const next = toFormState(latest.values)
    setLoaded({ version: latest.version, state: next })
    setState(next)
    setConflict(false)
    setErrors(new Map())
    setSummaryCount(0)
    setSaveAlert(null)
    setNotice(null)
    setSavedKeyword(latest.values.titleKeyword)
    setMatchedRegions(latest.matchedRegions)
  }

  const fieldsProps = { formId, state, errors, readOnly: isSaving, update }
  const sectionLayout = mode === "settings" ? "split" : "stack"
  const primaryLabel = mode === "settings" ? c.save.primarySettings : c.save.primaryWizard
  const primaryInert = mode === "settings" && !dirty

  return (
    <form ref={formRef} id={formId} noValidate onSubmit={submit} aria-busy={isSaving || undefined} className="flex flex-col gap-7">
      {conflict && (
        <Alert ref={conflictRef} tabIndex={-1} variant="destructive" className="outline-none">
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="font-normal">{c.conflict.text}</AlertTitle>
          <AlertAction className="static col-start-2 mt-2 justify-self-start">
            <Button type="button" variant="outline" size="sm" onClick={() => void reloadLatest()}>
              {c.conflict.action}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {summaryCount > 0 && errors.size > 0 && (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-xl border px-4 py-3 text-sm text-destructive-text outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <p className="flex items-start gap-2 font-medium">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {c.summary(errors.size)}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 ps-6">
            {[...errors.keys()].map((key) => (
              <li key={key}>
                <a
                  href={`#${fieldId(formId, key)}`}
                  className="underline underline-offset-4"
                  onClick={(event) => {
                    event.preventDefault()
                    document.getElementById(fieldId(formId, key))?.focus()
                  }}
                >
                  {SUMMARY_LABEL[key]}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Group title={c.section.locationHours} layout={sectionLayout}>
        <LocationHoursFields
          {...fieldsProps}
          notice={notice}
          matchedRegions={matchedRegions}
          onHomeChange={(code) => {
            const next = changeHomeCountry(state, code)
            setState(next.state)
            setNotice(next.notice)
          }}
        />
      </Group>
      <Group title={c.section.workArrangement} layout={sectionLayout}>
        <WorkArrangementFields {...fieldsProps} />
      </Group>
      <Group title={c.section.exclusions} layout={sectionLayout}>
        <ExclusionsFields {...fieldsProps} />
      </Group>
      <Group title={c.section.pay} layout={sectionLayout}>
        <PayFields {...fieldsProps} />
      </Group>
      <Group title={c.families.title} titleId={`${formId}-families-title`} description={c.families.help} layout={sectionLayout}>
        <RoleFamiliesFields {...fieldsProps} savedKeyword={savedKeyword} keywordFoldedEmpty={foldedEmpty} boardFamilies={boardFamilies} />
      </Group>
      <Group title={c.section.seniorityEmployment} layout={sectionLayout}>
        <SeniorityEmploymentFields {...fieldsProps} />
      </Group>
      <Group title={c.section.dailyCap} layout={sectionLayout}>
        <DailyCapField {...fieldsProps} todayCount={todayCount} />
      </Group>
      <Group title={c.section.documentEmphasis} layout={sectionLayout}>
        <ThemesField {...fieldsProps} />
      </Group>
      <div className="flex flex-col gap-3 border-t pt-7">
        {saveAlert && (
          <Alert ref={saveAlertRef} tabIndex={-1} variant="destructive" className="outline-none">
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="font-normal [overflow-wrap:anywhere]">{saveAlertText(saveAlert)}</AlertTitle>
            {(saveAlert.kind === "network" || saveAlert.kind === "wizardError") && (
              <AlertAction className="static col-start-2 mt-2 justify-self-start">
                <Button type="button" variant="outline" size="sm" onClick={() => submit()}>
                  {c.save.network.action}
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        <p className="max-w-[72ch] text-[0.8125rem] leading-[1.45] text-muted-foreground">{mode === "settings" ? c.save.helpSettings : c.save.help}</p>
        <div>
          <Button
            type="submit"
            size="lg"
            className="w-full sm:w-auto"
            aria-busy={isSaving || undefined}
            aria-disabled={isSaving || primaryInert || undefined}
            onClick={(event) => {
              if (isSaving || primaryInert) event.preventDefault()
            }}
          >
            {isSaving && <ButtonSpinner />}
            {isSaving ? c.save.saving : primaryLabel}
          </Button>
        </div>
        {mode === "settings" && savedAt && (
          // DP-B1-08: 8px below the primary (the footer gap is 12px), timestamp in tabular figures.
          <div data-slot="after-save" className="-mt-1 flex max-w-[72ch] flex-col gap-1 text-[0.8125rem] leading-[1.45] text-muted-foreground tabular-nums">
            <p>{c.save.applies(savedAt)}</p>
            <p>{c.save.appliesLater}</p>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.state === "blocked") blocker.reset()
        }}
        title={c.leave.title}
        body={c.leave.body}
        confirmLabel={c.leave.leave}
        pendingLabel={c.leave.leave}
        cancelLabel={c.leave.stay}
        isPending={false}
        onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
      />
    </form>
  )
}

/**
 * The heading that names the form: the Settings section's h2 (`#preferences`) or the wizard
 * step's h1. Both are `tabIndex=-1` focus targets.
 */
function sectionHeading(form: HTMLFormElement | null): HTMLElement | null {
  const region = form?.closest("section[aria-labelledby]")
  const id = region?.getAttribute("aria-labelledby")
  const heading = id ? document.getElementById(id) : (form?.parentElement?.querySelector<HTMLElement>("h1[tabindex='-1']") ?? null)
  return heading?.getAttribute("tabindex") === "-1" ? heading : null
}

function saveAlertText(alert: SaveAlert): string {
  switch (alert.kind) {
    case "network":
      return c.save.network.text
    case "rateLimited":
      return c.save.rateLimited
    case "wizardError":
      return c.wizard.error.text
    case "offline":
      return c.wizard.offline
    case "message":
      return alert.message
  }
}

function Group({
  title,
  titleId,
  description,
  layout,
  children,
}: {
  title: string
  titleId?: string
  description?: string
  layout: "split" | "stack"
  children: ReactNode
}) {
  return (
    <Section title={title} description={description} layout={layout} headingLevel="h3" headingProps={titleId ? { id: titleId } : undefined}>
      {children}
    </Section>
  )
}
