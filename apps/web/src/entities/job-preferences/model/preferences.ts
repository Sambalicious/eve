import type {
  CountryCode,
  FamilyTier,
  IndustryKey,
  PayCurrency,
  PreferencesDefaults,
  PreferencesValues,
  RegionKey,
  SeniorityLevel,
} from "@eve/contracts"

export type { CountryCode, FamilyTier, IndustryKey, PayCurrency, RegionKey, SeniorityLevel }

/** The stored values of one preferences version (contract v1.23.0, every key present). */
export type JobPreferencesValues = PreferencesValues
/** The values a Candidate with no record starts from (`STEP3_DEFAULTS`, read from the server). */
export type JobPreferencesDefaults = PreferencesDefaults

/**
 * The session Candidate's Job Preferences. `version` is null when no record exists
 * yet (wizard step 3 not saved); the first save then sends `baseVersion: null`.
 */
export type JobPreferences =
  | {
      readonly version: number
      readonly savedAt: string
      /** D41: a later time zone change is refused until this instant; null when allowed. */
      readonly timeZoneLockedUntil: string | null
      readonly matchedRegions: readonly RegionKey[]
      readonly values: JobPreferencesValues
    }
  | {
      readonly version: null
      readonly savedAt: null
      readonly timeZoneLockedUntil: null
      readonly matchedRegions: readonly RegionKey[]
      readonly values: JobPreferencesDefaults
    }

export type SavedJobPreferences = Extract<JobPreferences, { version: number }>

export interface SavePreferencesInput {
  readonly baseVersion: number | null
  /** Pay amounts may be typed text; the server normalises them to 2 decimals. */
  readonly values: Omit<JobPreferencesValues, "payFloor" | "preferredPay" | "homeCountry" | "timeZone"> & {
    readonly payFloor: PayInput | null
    readonly preferredPay: PayInput | null
    readonly homeCountry: CountryCode | null
    readonly timeZone: string | null
  }
}

export interface PayInput {
  readonly amount: string
  readonly currency: string
  readonly period: string
  readonly basis: "gross" | "net"
}

/** True when any family is set to Excluded (decides the Not a match excluded-family empty state and the All hint). */
export function hasExcludedFamily(values: Pick<JobPreferencesValues, "roleFamilyTiers">): boolean {
  return Object.values(values.roleFamilyTiers).some((tier) => tier === "excluded")
}
