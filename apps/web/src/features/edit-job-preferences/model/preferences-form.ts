import {
  EMPHASIS_THEME_MAX_LENGTH,
  isLatestWorkHour,
  normalisePayAmount,
  PAY_CURRENCIES,
  SUPPORTED_COUNTRIES,
  TITLE_KEYWORD_MAX_LENGTH,
  type PreferencesField,
  type PreferencesFieldError,
  type RoleFamilyValue,
} from "@eve/contracts"

import type {
  CountryCode,
  FamilyTier,
  IndustryKey,
  JobPreferencesDefaults,
  JobPreferencesValues,
  SavePreferencesInput,
  SeniorityLevel,
} from "@/entities/job-preferences"
import { prefsCopy as c } from "./copy"

type EmploymentType = JobPreferencesValues["employmentTypes"][number]

export interface PayState {
  readonly amount: string
  /** "" until chosen. */
  readonly currency: string
  readonly period: "month" | "year"
}

/** What the form edits. Text fields keep what was typed; the server normalises. */
export interface FormState {
  readonly homeCountry: CountryCode | null
  readonly timeZone: string
  readonly latestWorkHour: string
  readonly workAuthorizedCountries: readonly CountryCode[]
  readonly remoteAccepted: boolean
  readonly relocationAccepted: boolean
  readonly sponsorshipNeeded: boolean
  readonly excludedCountries: readonly CountryCode[]
  readonly industries: readonly IndustryKey[]
  readonly payFloor: PayState
  readonly preferredPay: PayState
  readonly tiers: Readonly<Record<RoleFamilyValue, FamilyTier>>
  readonly titleKeyword: string
  readonly seniority: readonly SeniorityLevel[]
  readonly employment: readonly EmploymentType[]
  readonly dailyCap: number
  /** Always three slots; blanks are not sent. */
  readonly themes: readonly [string, string, string]
}

/**
 * The form's error keys: the contract's field names. `workArrangement` covers both
 * arrangement checkboxes; pay splits into amount, currency and period.
 */
export type FieldKey = PreferencesField

/** Field order for the error summary and focus: the contract's field order (= the form's reading order). */
export const FIELD_ORDER: readonly FieldKey[] = [
  "homeCountry",
  "timeZone",
  "latestWorkHour",
  "workAuthorizedCountries",
  "workArrangement",
  "sponsorshipNeededForRelocation",
  "excludedRelocationCountries",
  "excludedIndustries",
  "payFloorAmount",
  "payFloorCurrency",
  "payFloorPeriod",
  "preferredPayAmount",
  "preferredPayCurrency",
  "preferredPayPeriod",
  "roleFamilyTiers",
  "titleKeyword",
  "seniorityLevels",
  "employmentTypes",
  "dailyCap",
  "emphasisThemes",
]

export type FieldErrors = ReadonlyMap<FieldKey, string>

const blankPay: PayState = { amount: "", currency: "", period: "month" }

export function toFormState(values: JobPreferencesValues | JobPreferencesDefaults): FormState {
  const pay = (p: JobPreferencesValues["payFloor"] | null): PayState =>
    p ? { amount: p.amount, currency: p.currency, period: p.period } : blankPay
  const themes = [...values.emphasisThemes, "", "", ""].slice(0, 3) as [string, string, string]
  return {
    homeCountry: values.homeCountry,
    timeZone: values.timeZone ?? "",
    latestWorkHour: values.latestWorkHour,
    workAuthorizedCountries: [...values.workAuthorizedCountries],
    remoteAccepted: values.remoteAccepted,
    relocationAccepted: values.relocationAccepted,
    sponsorshipNeeded: values.sponsorshipNeededForRelocation,
    excludedCountries: [...values.excludedRelocationCountries],
    industries: [...values.excludedIndustries],
    payFloor: pay(values.payFloor),
    preferredPay: pay(values.preferredPay),
    tiers: { ...values.roleFamilyTiers },
    titleKeyword: values.titleKeyword ?? "",
    seniority: [...values.seniorityLevels],
    employment: [...values.employmentTypes],
    dailyCap: values.dailyCap,
    themes,
  }
}

/** The PUT body. Every one of the 17 keys; the server validates and normalises. */
export function toSaveInput(state: FormState, baseVersion: number | null): SavePreferencesInput {
  const pay = (p: PayState, basis: "gross" | "net") => ({ amount: p.amount.trim(), currency: p.currency, period: p.period, basis })
  const keyword = state.titleKeyword.trim()
  return {
    baseVersion,
    values: {
      homeCountry: state.homeCountry,
      timeZone: state.timeZone.trim() === "" ? null : state.timeZone.trim(),
      latestWorkHour: state.latestWorkHour,
      workAuthorizedCountries: [...state.workAuthorizedCountries],
      remoteAccepted: state.remoteAccepted,
      relocationAccepted: state.relocationAccepted,
      sponsorshipNeededForRelocation: state.sponsorshipNeeded,
      excludedRelocationCountries: [...state.excludedCountries],
      excludedIndustries: [...state.industries],
      payFloor: pay(state.payFloor, "gross"),
      preferredPay: pay(state.preferredPay, "net"),
      roleFamilyTiers: { ...state.tiers },
      titleKeyword: keyword === "" ? null : state.titleKeyword,
      seniorityLevels: [...state.seniority],
      employmentTypes: [...state.employment],
      dailyCap: state.dailyCap,
      emphasisThemes: state.themes.filter((theme) => theme.trim() !== ""),
    },
  }
}

const hasControl = (value: string) => [...value].some((ch) => {
  const code = ch.charCodeAt(0)
  return code <= 0x08 || (code >= 0x0e && code <= 0x1f) || code === 0x7f
})

/** The inline message for each field. One message per field, as the copy deck gives one. */
const MESSAGE: Record<FieldKey, string> = {
  homeCountry: c.home.error,
  timeZone: c.timeZone.error,
  latestWorkHour: c.hour.error,
  workAuthorizedCountries: c.workAuth.help,
  workArrangement: c.arrangement.error,
  sponsorshipNeededForRelocation: c.sponsorship.label,
  excludedRelocationCountries: c.excludedCountries.error,
  excludedIndustries: c.industries.label,
  payFloorAmount: c.pay.amountError,
  payFloorCurrency: c.pay.currencyError,
  payFloorPeriod: c.pay.currencyError,
  preferredPayAmount: c.pay.amountError,
  preferredPayCurrency: c.pay.currencyError,
  preferredPayPeriod: c.pay.currencyError,
  roleFamilyTiers: c.families.noneTiered,
  titleKeyword: c.keyword.tooLong,
  seniorityLevels: c.seniority.error,
  employmentTypes: c.employment.error,
  dailyCap: c.cap.help,
  emphasisThemes: c.themes.error,
}

function ordered(errors: Map<FieldKey, string>): FieldErrors {
  return new Map(FIELD_ORDER.filter((key) => errors.has(key)).map((key) => [key, errors.get(key)!]))
}

/** Client validation with the server's rules (contract v1.23.0). The server stays authoritative. */
export function validate(state: FormState): FieldErrors {
  const errors = new Map<FieldKey, string>()
  if (state.homeCountry === null) errors.set("homeCountry", c.home.error)
  if (state.timeZone.trim() === "") errors.set("timeZone", c.timeZone.error)
  if (!isLatestWorkHour(state.latestWorkHour)) errors.set("latestWorkHour", c.hour.error)
  if (!state.remoteAccepted && !state.relocationAccepted) errors.set("workArrangement", c.arrangement.error)
  if (state.homeCountry && state.excludedCountries.includes(state.homeCountry)) errors.set("excludedRelocationCountries", c.excludedCountries.error)
  const pay = (p: PayState, prefix: "payFloor" | "preferredPay") => {
    if (normalisePayAmount(p.amount.trim()) === null) errors.set(`${prefix}Amount`, c.pay.amountError)
    if (!(PAY_CURRENCIES as readonly string[]).includes(p.currency)) errors.set(`${prefix}Currency`, c.pay.currencyError)
  }
  pay(state.payFloor, "payFloor")
  pay(state.preferredPay, "preferredPay")
  if (Object.values(state.tiers).every((tier) => tier === "excluded")) errors.set("roleFamilyTiers", c.families.noneTiered)
  if (hasControl(state.titleKeyword)) errors.set("titleKeyword", c.keyword.control)
  else if (state.titleKeyword.trim().length > TITLE_KEYWORD_MAX_LENGTH) errors.set("titleKeyword", c.keyword.tooLong)
  if (state.seniority.length === 0) errors.set("seniorityLevels", c.seniority.error)
  if (state.employment.length === 0) errors.set("employmentTypes", c.employment.error)
  if (state.themes.some((theme) => [...theme.trim()].length > EMPHASIS_THEME_MAX_LENGTH)) errors.set("emphasisThemes", c.themes.error)
  return ordered(errors)
}

/** Maps a `400 bad_request` `fieldErrors` list to inline messages (never echoes a value). */
export function fieldErrorsFromServer(items: readonly PreferencesFieldError[]): FieldErrors {
  const errors = new Map<FieldKey, string>()
  for (const item of items) {
    if (errors.has(item.field)) continue
    const message =
      item.field === "titleKeyword" && item.problem === "control_characters"
        ? c.keyword.control
        : item.field === "roleFamilyTiers" && item.problem !== "no_family_tiered"
          ? c.families.noneTiered
          : MESSAGE[item.field]
    errors.set(item.field, message)
  }
  return ordered(errors)
}

export interface HomeChangeNotice {
  readonly next: CountryCode
  readonly old: CountryCode
  /** The new home was in excluded relocation countries and was removed. */
  readonly unexcluded: boolean
}

/**
 * F4 step 8 / AC 4.3-4.5: choosing a home country puts it first in work
 * authorization (locked), keeps the old one removable, and removes it from the
 * excluded list. Time zone defaults from the country only when none is set yet.
 */
export function changeHomeCountry(state: FormState, next: CountryCode): { state: FormState; notice: HomeChangeNotice | null } {
  const old = state.homeCountry
  if (old === next) return { state, notice: null }
  const unexcluded = state.excludedCountries.includes(next)
  const updated: FormState = {
    ...state,
    homeCountry: next,
    timeZone: state.timeZone === "" ? SUPPORTED_COUNTRIES[next] : state.timeZone,
    workAuthorizedCountries: [next, ...state.workAuthorizedCountries.filter((code) => code !== next)],
    excludedCountries: state.excludedCountries.filter((code) => code !== next),
  }
  return { state: updated, notice: old === null ? null : { next, old, unexcluded } }
}

export function isDirty(state: FormState, loaded: FormState): boolean {
  return JSON.stringify(state) !== JSON.stringify(loaded)
}

/** DOM id of each field's focus target, for the error summary links and focus on refusal. */
export const fieldId = (formId: string, key: FieldKey) => `${formId}-${key}`
