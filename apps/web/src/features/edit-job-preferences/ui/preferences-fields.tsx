import { useId, type ReactNode } from "react"
import { CircleAlert, EyeOff, Info } from "lucide-react"
import { PAY_CURRENCIES, roleFamilySchema, type RegionKey, type RoleFamilyValue } from "@eve/contracts"
import { Link } from "react-router-dom"

import type { CountryCode, IndustryKey, SeniorityLevel } from "@/entities/job-preferences"
import { roleFamilyLabel } from "@/entities/job-posting"
import { Badge } from "@/shared/ui/badge"
import { Checkbox } from "@/shared/ui/checkbox"
import { FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { NativeSelect } from "@/shared/ui/native-select"
import { prefsCopy as c } from "../model/copy"
import { countryName, currencyOption, REGION_LABEL, timeZoneOptions } from "../model/display"
import { fieldId, type FieldErrors, type FormState, type HomeChangeNotice, type PayState } from "../model/preferences-form"
import { CountryPicker } from "./country-picker"
import { SegmentedRadio } from "./segmented-radio"


export interface FieldsProps {
  formId: string
  state: FormState
  errors: FieldErrors
  readOnly: boolean
  update: (patch: Partial<FormState>) => void
}

function ErrorLine({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null
  return (
    <FieldError id={id} role={undefined} className="flex items-start gap-1.5">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {message}
    </FieldError>
  )
}

const describe = (...ids: (string | false | null | undefined)[]) => ids.filter(Boolean).join(" ") || undefined

/** A labelled field block: label, control, help, error. */
function TextField({
  id,
  label,
  help,
  error,
  children,
  suffix,
}: {
  id: string
  label: string
  help?: ReactNode
  error?: string
  children: ReactNode
  suffix?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} id={`${id}-label`}>
        {label}
        {suffix}
      </FieldLabel>
      {children}
      {help && <FieldDescription id={`${id}-help`}>{help}</FieldDescription>}
      <ErrorLine id={`${id}-error`} message={error} />
    </div>
  )
}

export function LocationHoursFields({
  formId,
  state,
  errors,
  readOnly,
  update,
  onHomeChange,
  notice,
  matchedRegions,
}: FieldsProps & { onHomeChange: (code: CountryCode) => void; notice: HomeChangeNotice | null; matchedRegions: readonly RegionKey[] }) {
  const home = fieldId(formId, "homeCountry")
  const zone = fieldId(formId, "timeZone")
  const hour = fieldId(formId, "latestWorkHour")
  const auth = fieldId(formId, "workAuthorizedCountries")
  return (
    <div className="flex flex-col gap-5">
      <TextField id={home} label={c.home.label} help={c.home.help} error={errors.get("homeCountry")}>
        <CountryPicker
          id={home}
          labelId={`${home}-label`}
          title={c.home.label}
          closeLabel="Close"
          single
          selected={state.homeCountry ? [state.homeCountry] : []}
          describedBy={describe(`${home}-help`, errors.has("homeCountry") && `${home}-error`, notice && `${home}-notice`)}
          invalid={errors.has("homeCountry")}
          readOnly={readOnly}
          onChange={([code]) => code && onHomeChange(code)}
        />
        {notice && (
          <div id={`${home}-notice`} role="status" className="flex flex-col gap-1 text-[0.8125rem] leading-[1.45]">
            <p className="flex items-start gap-1.5">
              <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {c.homeChanged(countryName(notice.next), countryName(notice.old))}
            </p>
            {notice.unexcluded && <p className="ps-5">{c.homeUnexcluded(countryName(notice.next))}</p>}
          </div>
        )}
      </TextField>
      <TextField id={zone} label={c.timeZone.label} help={c.timeZone.help} error={errors.get("timeZone")}>
        <div className="sm:max-w-80">
          <NativeSelect
            id={zone}
            value={state.timeZone}
            disabled={false}
            aria-readonly={readOnly || undefined}
            aria-invalid={errors.has("timeZone") || undefined}
            aria-describedby={describe(`${zone}-help`, errors.has("timeZone") && `${zone}-error`)}
            onChange={(event) => !readOnly && update({ timeZone: event.target.value })}
          >
            <option value="" disabled hidden></option>
            {timeZoneOptions(state.timeZone).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </TextField>
      <TextField id={hour} label={c.hour.label} help={c.hour.help} error={errors.get("latestWorkHour")}>
        <Input
          id={hour}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="23:00"
          className="w-28 tabular-nums"
          value={state.latestWorkHour}
          readOnly={readOnly}
          aria-invalid={errors.has("latestWorkHour") || undefined}
          aria-describedby={describe(`${hour}-help`, errors.has("latestWorkHour") && `${hour}-error`)}
          onChange={(event) => update({ latestWorkHour: event.target.value })}
        />
      </TextField>
      <TextField id={auth} label={c.workAuth.label} help={c.workAuth.help} error={errors.get("workAuthorizedCountries")}>
        <CountryPicker
          id={auth}
          labelId={`${auth}-label`}
          title="Countries you can work in"
          closeLabel="Close"
          selected={state.workAuthorizedCountries}
          locked={state.homeCountry}
          lockedHint={c.workAuth.locked}
          describedBy={describe(`${auth}-help`, errors.has("workAuthorizedCountries") && `${auth}-error`)}
          invalid={errors.has("workAuthorizedCountries")}
          readOnly={readOnly}
          onChange={(next) => update({ workAuthorizedCountries: state.homeCountry ? [state.homeCountry, ...next.filter((code) => code !== state.homeCountry)] : next })}
        />
        {matchedRegions.length > 0 && (
          <details className="text-[0.8125rem] leading-[1.45]">
            <summary className="cursor-pointer text-foreground underline-offset-4 hover:underline">Which regions include your countries?</summary>
            <p className="mt-1 text-muted-foreground">
              Jobs limited to these regions count as open to you: {matchedRegions.map((key) => REGION_LABEL[key]).join(", ")}. Other region names, like
              "Western Europe", and worldwide wording, like "anywhere", aren't recognised, so those jobs are marked Unverified for location.
            </p>
          </details>
        )}
      </TextField>
    </div>
  )
}

type Arrangement = "remote" | "relocation" | "both"

export function WorkArrangementFields({ formId, state, errors, readOnly, update }: FieldsProps) {
  const id = fieldId(formId, "workArrangement")
  const spons = fieldId(formId, "sponsorshipNeededForRelocation")
  const value: Arrangement | "" = state.remoteAccepted && state.relocationAccepted ? "both" : state.remoteAccepted ? "remote" : state.relocationAccepted ? "relocation" : ""
  return (
    <div className="flex flex-col gap-5">
      <FieldSet className="gap-1.5">
        <FieldLegend variant="label" id={`${id}-label`} className="mb-0">
          {c.arrangement.label}
        </FieldLegend>
        <SegmentedRadio<Arrangement | "">
          id={id}
          value={value}
          labelledBy={`${id}-label`}
          describedBy={errors.has("workArrangement") ? `${id}-error` : undefined}
          invalid={errors.has("workArrangement")}
          readOnly={readOnly}
          options={[
            { value: "remote", label: c.arrangement.remote },
            { value: "relocation", label: c.arrangement.relocation },
            { value: "both", label: c.arrangement.both },
          ]}
          onChange={(next) => update({ remoteAccepted: next !== "relocation", relocationAccepted: next !== "remote" })}
        />
        <ErrorLine id={`${id}-error`} message={errors.get("workArrangement")} />
      </FieldSet>
      <FieldSet className="gap-1.5">
        <FieldLegend variant="label" id={`${spons}-label`} className="mb-0">
          {c.sponsorship.label}
        </FieldLegend>
        <SegmentedRadio<"yes" | "no">
          id={spons}
          value={state.sponsorshipNeeded ? "yes" : "no"}
          labelledBy={`${spons}-label`}
          describedBy={`${spons}-help`}
          readOnly={readOnly}
          options={[
            { value: "yes", label: c.sponsorship.yes },
            { value: "no", label: c.sponsorship.no },
          ]}
          onChange={(next) => update({ sponsorshipNeeded: next === "yes" })}
        />
        <FieldDescription id={`${spons}-help`}>{c.sponsorship.help}</FieldDescription>
      </FieldSet>
    </div>
  )
}

function CheckboxGroup<T extends string>({
  id,
  label,
  options,
  selected,
  error,
  readOnly,
  onChange,
}: {
  id: string
  label: string
  options: readonly { value: T; label: string }[]
  selected: readonly T[]
  error?: string
  readOnly: boolean
  onChange: (next: T[]) => void
}) {
  return (
    <FieldSet className="gap-1.5" aria-labelledby={`${id}-label`} aria-describedby={error ? `${id}-error` : undefined} aria-invalid={error ? true : undefined}>
      <FieldLegend variant="label" id={`${id}-label`} className="mb-0">
        {label}
      </FieldLegend>
      <ErrorLine id={`${id}-error`} message={error} />
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {options.map((option, index) => (
          <label key={option.value} className="flex min-h-8 cursor-pointer items-start gap-2.5 py-1 pointer-coarse:min-h-10">
            <Checkbox
              id={index === 0 ? id : undefined}
              className="mt-0.5"
              aria-labelledby={`${id}-opt-${option.value}`}
              checked={selected.includes(option.value)}
              readOnly={readOnly}
              onCheckedChange={(checked) =>
                !readOnly && onChange(options.map((o) => o.value).filter((v) => (v === option.value ? checked : selected.includes(v))))
              }
            />
            <span id={`${id}-opt-${option.value}`} className="text-sm leading-snug [overflow-wrap:anywhere]">{option.label}</span>
          </label>
        ))}
      </div>
    </FieldSet>
  )
}

export function ExclusionsFields({ formId, state, errors, readOnly, update }: FieldsProps) {
  const excluded = fieldId(formId, "excludedRelocationCountries")
  return (
    <div className="flex flex-col gap-5">
      <TextField id={excluded} label={c.excludedCountries.label} error={errors.get("excludedRelocationCountries")}>
        <CountryPicker
          id={excluded}
          labelId={`${excluded}-label`}
          title={c.excludedCountries.label}
          closeLabel="Close"
          selected={state.excludedCountries}
          omit={state.homeCountry ? [state.homeCountry] : []}
          describedBy={errors.has("excludedRelocationCountries") ? `${excluded}-error` : undefined}
          invalid={errors.has("excludedRelocationCountries")}
          readOnly={readOnly}
          onChange={(next) => update({ excludedCountries: next })}
        />
      </TextField>
      <CheckboxGroup<IndustryKey>
        id={fieldId(formId, "excludedIndustries")}
        label={c.industries.label}
        options={(Object.keys(c.industries.option) as IndustryKey[]).map((value) => ({ value, label: c.industries.option[value] }))}
        selected={state.industries}
        error={errors.get("excludedIndustries")}
        readOnly={readOnly}
        onChange={(next) => update({ industries: next })}
      />
    </div>
  )
}

function PayGroup({
  formId,
  prefix,
  pay,
  label,
  currencyLabel,
  help,
  suffix,
  errors,
  readOnly,
  onChange,
  showCurrencyHelp,
}: {
  currencyLabel: string
  formId: string
  prefix: "payFloor" | "preferredPay"
  pay: PayState
  label: string
  help: string
  suffix: string
  errors: FieldErrors
  readOnly: boolean
  onChange: (next: PayState) => void
  showCurrencyHelp: boolean
}) {
  const amount = fieldId(formId, `${prefix}Amount`)
  const currency = fieldId(formId, `${prefix}Currency`)
  const period = fieldId(formId, `${prefix}Period`)
  const legendId = `${formId}-${prefix}-legend`
  return (
    <FieldSet className="gap-1.5" aria-labelledby={legendId}>
      <FieldLegend variant="label" id={legendId} className="mb-0">
        {label}
      </FieldLegend>
      {/* DP-B1-06 (r4 :1417): at 375px amount, currency and period+suffix are three rows; from md one row. */}
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <div className="flex items-center gap-2">
          <Input
            id={amount}
            inputMode="decimal"
            autoComplete="off"
            className="w-full tabular-nums md:w-36"
            aria-labelledby={legendId}
            value={pay.amount}
            readOnly={readOnly}
            aria-invalid={errors.has(`${prefix}Amount`) || undefined}
            aria-describedby={describe(`${legendId}-help`, errors.has(`${prefix}Amount`) && `${amount}-error`)}
            onChange={(event) => onChange({ ...pay, amount: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="w-full sm:w-56">
            <label htmlFor={currency} className="sr-only">
              {currencyLabel}
            </label>
            <NativeSelect
              id={currency}
              value={pay.currency}
              aria-readonly={readOnly || undefined}
              aria-invalid={errors.has(`${prefix}Currency`) || undefined}
              aria-describedby={describe(showCurrencyHelp && `${formId}-currency-help`, errors.has(`${prefix}Currency`) && `${currency}-error`)}
              onChange={(event) => !readOnly && onChange({ ...pay, currency: event.target.value })}
            >
              <option value="" disabled hidden></option>
              {PAY_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {currencyOption(code)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex items-center gap-2">
          <SegmentedRadio<"month" | "year">
            id={period}
            className="w-auto"
            value={pay.period}
            labelledBy={legendId}
            readOnly={readOnly}
            options={[
              { value: "month", label: c.pay.period.month },
              { value: "year", label: c.pay.period.year },
            ]}
            onChange={(next) => onChange({ ...pay, period: next })}
          />
          <span className="text-[0.8125rem] text-muted-foreground">{suffix}</span>
          </div>
        </div>
      </div>
      <FieldDescription id={`${legendId}-help`}>{help}</FieldDescription>
      {showCurrencyHelp && <FieldDescription id={`${formId}-currency-help`}>{c.pay.currencyHelp}</FieldDescription>}
      <ErrorLine id={`${amount}-error`} message={errors.get(`${prefix}Amount`)} />
      <ErrorLine id={`${currency}-error`} message={errors.get(`${prefix}Currency`) ?? errors.get(`${prefix}Period`)} />
    </FieldSet>
  )
}

export function PayFields({ formId, state, errors, readOnly, update }: FieldsProps) {
  return (
    <div className="flex flex-col gap-6">
      <PayGroup formId={formId} prefix="payFloor" pay={state.payFloor} label={c.pay.floor.label} currencyLabel={c.pay.floor.currencyLabel} help={c.pay.floor.help} suffix={c.pay.suffix.gross} errors={errors} readOnly={readOnly} onChange={(payFloor) => update({ payFloor })} showCurrencyHelp />
      <PayGroup formId={formId} prefix="preferredPay" pay={state.preferredPay} label={c.pay.preferred.label} currencyLabel={c.pay.preferred.currencyLabel} help={c.pay.preferred.help} suffix={c.pay.suffix.net} errors={errors} readOnly={readOnly} onChange={(preferredPay) => update({ preferredPay })} showCurrencyHelp={false} />
    </div>
  )
}

const TIER_OPTIONS = [
  { value: "1", label: c.families.tier[1] },
  { value: "2", label: c.families.tier[2] },
  { value: "3", label: c.families.tier[3] },
  { value: "excluded", label: c.families.tier.excluded },
] as const

/** B-PREF-1: one fieldset per family in catalog order, named by its label; then the saved keyword. */
export function RoleFamiliesFields({
  formId,
  state,
  errors,
  readOnly,
  update,
  savedKeyword,
  keywordFoldedEmpty,
  boardFamilies,
}: FieldsProps & { savedKeyword: string | null; keywordFoldedEmpty: boolean; boardFamilies?: readonly RoleFamilyValue[] }) {
  const groupId = fieldId(formId, "roleFamilyTiers")
  const keyword = fieldId(formId, "titleKeyword")
  const anyExcluded = Object.values(state.tiers).some((tier) => tier === "excluded")
  const tiersError = errors.get("roleFamilyTiers")
  const hidden = boardFamilies ? roleFamilySchema.options.filter((family) => !boardFamilies.includes(family)) : []
  return (
    <div className="flex flex-col gap-6">
      <div
        role="group"
        aria-labelledby={`${formId}-families-title`}
        aria-describedby={describe(tiersError && `${groupId}-error`)}
        className="flex flex-col gap-1"
      >
        <ErrorLine id={`${groupId}-error`} message={tiersError} />
        <ul className="flex flex-col divide-y divide-border">
          {roleFamilySchema.options.map((family, index) => (
            <li key={family}>
              <fieldset className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <legend className="float-left text-sm leading-snug sm:float-none sm:contents" id={`${formId}-family-${family}`}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:min-w-0 sm:flex-1">
                    {roleFamilyLabel[family]}
                    {hidden.includes(family) && (
                      <>
                        <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
                          <EyeOff aria-hidden="true" className="size-3" />
                          {c.families.hiddenTag}
                        </Badge>
                      </>
                    )}
                  </span>
                </legend>
                <SegmentedRadio<string>
                  id={index === 0 ? groupId : undefined}
                  className="clear-left"
                  value={String(state.tiers[family])}
                  labelledBy={`${formId}-family-${family}`}
                  label={hidden.includes(family) ? `${roleFamilyLabel[family]}, ${c.families.hiddenTag}` : undefined}
                  readOnly={readOnly}
                  options={TIER_OPTIONS}
                  onChange={(next) => update({ tiers: { ...state.tiers, [family]: next === "excluded" ? "excluded" : (Number(next) as 1 | 2 | 3) } })}
                />
              </fieldset>
            </li>
          ))}
        </ul>
        {hidden.length > 0 && (
          <p className="max-w-[72ch] text-[0.8125rem] leading-[1.45] text-muted-foreground">
            {c.families.hiddenNote(hidden.length)}{" "}
            <Link to={c.families.criteriaHref} className="text-foreground underline underline-offset-4">
              {c.families.criteriaLink}
            </Link>
          </p>
        )}
        {anyExcluded && (
          <p className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.45] text-muted-foreground">
            <EyeOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {c.families.excludedNote}
          </p>
        )}
      </div>
      <TextField
        id={keyword}
        label={c.keyword.label}
        suffix={<span className="ms-2 font-normal text-muted-foreground">{c.keyword.optional}</span>}
        help={c.keyword.help}
        error={errors.get("titleKeyword")}
      >
        <Input
          id={keyword}
          className="sm:max-w-80"
          placeholder={c.keyword.placeholder}
          autoComplete="off"
          dir="auto"
          value={state.titleKeyword}
          readOnly={readOnly}
          aria-invalid={errors.has("titleKeyword") || undefined}
          aria-describedby={describe(`${keyword}-help`, errors.has("titleKeyword") && `${keyword}-error`, savedKeyword && `${keyword}-active`, keywordFoldedEmpty && `${keyword}-info`)}
          onChange={(event) => update({ titleKeyword: event.target.value })}
        />
      </TextField>
      {savedKeyword && <KeywordActive id={`${keyword}-active`} keyword={savedKeyword} />}
      {keywordFoldedEmpty && (
        <p id={`${keyword}-info`} role="status" className="-mt-4 flex items-start gap-1.5 text-[0.8125rem] leading-[1.45] text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {c.keyword.infoEmpty}
        </p>
      )}
    </div>
  )
}

function KeywordActive({ id, keyword }: { id: string; keyword: string }) {
  const line = c.keyword.active(keyword)
  return (
    <p id={id} className="-mt-4 text-[0.8125rem] leading-[1.45] [overflow-wrap:anywhere]">
      {line.before}
      <span dir="auto">{line.keyword}</span>
      {line.after}
    </p>
  )
}

export function SeniorityEmploymentFields({ formId, state, errors, readOnly, update }: FieldsProps) {
  return (
    <div className="flex flex-col gap-5">
      <CheckboxGroup<SeniorityLevel>
        id={fieldId(formId, "seniorityLevels")}
        label={c.seniority.label}
        options={(Object.keys(c.seniority.option) as SeniorityLevel[]).map((value) => ({ value, label: c.seniority.option[value] }))}
        selected={state.seniority}
        error={errors.get("seniorityLevels")}
        readOnly={readOnly}
        onChange={(next) => update({ seniority: next })}
      />
      <CheckboxGroup<FormState["employment"][number]>
        id={fieldId(formId, "employmentTypes")}
        label={c.employment.label}
        options={(["direct", "employer_of_record", "contract"] as const).map((value) => ({ value, label: c.employment.option[value] }))}
        selected={state.employment}
        error={errors.get("employmentTypes")}
        readOnly={readOnly}
        onChange={(next) => update({ employment: next })}
      />
    </div>
  )
}

export function DailyCapField({ formId, state, readOnly, update, todayCount }: FieldsProps & { todayCount: number | null }) {
  const id = fieldId(formId, "dailyCap")
  const warn = todayCount !== null && state.dailyCap <= todayCount
  return (
    <FieldSet className="gap-1.5">
      <FieldLegend variant="label" id={`${id}-label`} className="mb-0">
        {c.cap.label}
      </FieldLegend>
      <SegmentedRadio<number>
        id={id}
        value={state.dailyCap}
        labelledBy={`${id}-label`}
        describedBy={describe(`${id}-help`, warn && `${id}-warn`)}
        readOnly={readOnly}
        options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n), srLabel: c.cap.optionSr(n) }))}
        onChange={(dailyCap) => update({ dailyCap })}
      />
      <FieldDescription id={`${id}-help`}>{c.cap.help}</FieldDescription>
      {warn && todayCount !== null && (
        <p id={`${id}-warn`} className="text-[0.8125rem] leading-[1.45]">
          {c.cap.warn(todayCount)}
        </p>
      )}
    </FieldSet>
  )
}

export function ThemesField({ formId, state, errors, readOnly, update }: FieldsProps) {
  const id = fieldId(formId, "emphasisThemes")
  const autoId = useId()
  return (
    <FieldSet className="gap-1.5" aria-labelledby={`${id}-label`} aria-describedby={describe(`${id}-help`, errors.has("emphasisThemes") && `${id}-error`)}>
      <FieldLegend variant="label" id={`${id}-label`} className="mb-0">
        {c.themes.label}
      </FieldLegend>
      <FieldDescription id={`${id}-help`}>{c.themes.help}</FieldDescription>
      <ErrorLine id={`${id}-error`} message={errors.get("emphasisThemes")} />
      {state.themes.map((theme, index) => {
        const length = [...theme.trim()].length
        const inputId = index === 0 ? id : `${autoId}-${index}`
        return (
          <div key={index} className="flex items-center gap-2">
            <Input
              id={inputId}
              className="sm:max-w-96"
              autoComplete="off"
              aria-label={`${c.themes.label} ${index + 1}`}
              aria-describedby={`${inputId}-count`}
              aria-invalid={(errors.has("emphasisThemes") && length > 60) || undefined}
              value={theme}
              readOnly={readOnly}
              onChange={(event) => {
                const next = [...state.themes] as [string, string, string]
                next[index] = event.target.value
                update({ themes: next })
              }}
            />
            <span id={`${inputId}-count`} className={`w-12 shrink-0 text-xs tabular-nums ${length > 60 ? "text-destructive-text" : "text-muted-foreground"}`}>
              {c.themes.count(length)}
            </span>
          </div>
        )
      })}
    </FieldSet>
  )
}
