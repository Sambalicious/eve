import { z } from "zod"

import { employmentTypeSchema, roleFamilySchema, type RoleFamilyValue } from "./discovery.js"
import { keywordFoldsToEmpty } from "./keyword-fold.js"

/**
 * EPIC-0002 slice B1 (contract v1.25.0): the session Candidate's Job Preferences.
 * One record per Candidate, versioned. Every route acts on the session Candidate
 * only and takes no Candidate ID. B1 has no Job criteria fields: the minimum core
 * Match, Frameworks and Technologies join in slice B2 (architecture.r6 "Slice split").
 */
export const ME_PREFERENCES_PATH = "/v1/me/preferences"
/** D40: read-only history of the session Candidate's own preference versions. No screen in B1. */
export const ME_PREFERENCES_VERSIONS_PATH = "/v1/me/preferences/versions"

/** R6-AC6: `PUT /v1/me/preferences` attempts per session in a sliding 60 s window (`PreferencesSaveLimiter`). */
export const PREFERENCES_SAVE_LIMIT = 10
export const PREFERENCES_SAVE_WINDOW_SECONDS = 60
/** D41: a later time zone change is refused for 24 hours after the last one. The first time zone set is free. */
export const TIME_ZONE_CHANGE_INTERVAL_HOURS = 24
export const PREFERENCES_VERSIONS_DEFAULT_LIMIT = 50
export const PREFERENCES_VERSIONS_MAX_LIMIT = 100

/**
 * PRD r4 AC 4.2: the supported countries, ISO 3166-1 alpha-2, each with the
 * time zone that home country defaults to (AC 4.3). Nigeria, Ghana, Kenya,
 * South Africa and Egypt, plus every country in the EPIC-0001 relocation place
 * list (`apps/api/src/discovery/rules/locations.ts` `PLACES`). Sorted by code.
 * Country names and cities for the rules live in the api; display names are web copy.
 */
export const SUPPORTED_COUNTRIES = Object.freeze({
  AE: "Asia/Dubai",
  CA: "America/Toronto",
  CH: "Europe/Zurich",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  EG: "Africa/Cairo",
  ES: "Europe/Madrid",
  FR: "Europe/Paris",
  GB: "Europe/London",
  GH: "Africa/Accra",
  IE: "Europe/Dublin",
  JO: "Asia/Amman",
  KE: "Africa/Nairobi",
  LB: "Asia/Beirut",
  NG: "Africa/Lagos",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  OM: "Asia/Muscat",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  QA: "Asia/Qatar",
  SA: "Asia/Riyadh",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  TH: "Asia/Bangkok",
  TR: "Europe/Istanbul",
  US: "America/New_York",
  ZA: "Africa/Johannesburg",
} as const satisfies Record<string, string>)
export type CountryCode = keyof typeof SUPPORTED_COUNTRIES
export const countryCodeSchema = z.enum(Object.keys(SUPPORTED_COUNTRIES) as [CountryCode, ...CountryCode[]])

/** AC 4.3: the latest work hour every home country defaults to. */
export const DEFAULT_LATEST_WORK_HOUR = "23:00"

/**
 * AC 4.10: pay currencies are exactly the exchange-rate table
 * (`apps/api/src/discovery/fx-rates.ts`), USD first, EUR second, then by code.
 * An api test keeps the two equal; adding a dated rate adds the code here too.
 */
export const PAY_CURRENCIES = Object.freeze([
  "USD", "EUR", "AUD", "BRL", "CAD", "CHF", "CZK", "DKK", "GBP", "ILS",
  "INR", "JPY", "MXN", "NOK", "NZD", "PLN", "SEK", "SGD", "TRY", "ZAR",
] as const)
export const payCurrencySchema = z.enum(PAY_CURRENCIES)
export type PayCurrency = z.infer<typeof payCurrencySchema>

/** AC 4.9: the fixed excluded-industry catalog, in display order. Each key has a keyword floor in api code. */
export const industryKeySchema = z.enum([
  "adult_content",
  "video_games_and_gaming_platforms",
  "gambling",
  "betting",
  "crypto_and_web3",
  "weapons_and_defense",
  "tobacco_and_vaping",
])
export type IndustryKey = z.infer<typeof industryKeySchema>

/** AC 4.17. */
export const seniorityLevelSchema = z.enum(["junior", "mid", "senior", "staff", "principal"])
export type SeniorityLevel = z.infer<typeof seniorityLevelSchema>

/** AC 4.11: tiers 1 to 3 rank; `excluded` skips with `excluded_role_family`. */
export const familyTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("excluded")])
export type FamilyTier = z.infer<typeof familyTierSchema>

/**
 * The tier map a new Candidate starts with (= the Operator's migrated tiers, built
 * `ranking.ts` `TIER` + 1): every `roleFamilySchema` key, none excluded.
 */
export const DEFAULT_ROLE_FAMILY_TIERS: Readonly<Record<RoleFamilyValue, FamilyTier>> = Object.freeze({
  senior_frontend: 1,
  technical_lead: 1,
  fullstack: 2,
  product_engineering: 2,
  software_engineering: 3,
  backend: 3,
  mobile: 3,
  platform_engineering: 3,
  devops_platform: 3,
  people_management: 3,
  data_ml: 3,
  solutions_customer: 3,
  other: 3,
})

export const PAY_AMOUNT_MAX = 100_000_000
export const EMPHASIS_THEMES_MAX = 3
export const EMPHASIS_THEME_MAX_LENGTH = 60
export const TITLE_KEYWORD_MAX_LENGTH = 100

/** `HH:MM`, 01:00 to 23:59 in whole minutes (AC 4.3, E3). */
export function isLatestWorkHour(value: unknown): value is string {
  return typeof value === "string" && /^(0[1-9]|1\d|2[0-3]):[0-5]\d$/.test(value)
}

/**
 * AC 4.3: an IANA zone name, exact case, as the runtime's ICU lists it
 * (`Intl.supportedValuesOf("timeZone")`), or `UTC`. "WAT", "GMT+1" and
 * "africa/nairobi" are refused. The server's answer is authoritative.
 */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value === "UTC") return true
  return Intl.supportedValuesOf("timeZone").includes(value)
}

/** A decimal string or number greater than 0 with at most 2 decimals, at most 100,000,000. Returns the 2-decimal string. */
export function normalisePayAmount(value: unknown): string | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : null
  if (text === null || !/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null
  const amount = Number(text)
  if (!(amount > 0) || amount > PAY_AMOUNT_MAX) return null
  return amount.toFixed(2)
}

/** C0 controls other than whitespace (U+0000 to U+0008, U+000E to U+001F) and DEL, as the slice 8 keyword rule (v1.12.1). */
function hasNonWhitespaceControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x08 || (code >= 0x0e && code <= 0x1f) || code === 0x7f) return true
  }
  return false
}

const payBody = (basis: "gross" | "net") =>
  z
    .object({
      /** 2-decimal string, e.g. "2000.00". */
      amount: z.string().regex(/^\d{1,9}\.\d{2}$/),
      currency: payCurrencySchema,
      period: z.enum(["month", "year"]),
      basis: z.literal(basis),
    })
    .strict()
export const payFloorSchema = payBody("gross")
export const preferredPaySchema = payBody("net")
export type PayFloor = z.infer<typeof payFloorSchema>
export type PreferredPay = z.infer<typeof preferredPaySchema>

const roleFamilyTiersSchema = z
  .object(Object.fromEntries(roleFamilySchema.options.map((family) => [family, familyTierSchema])) as Record<RoleFamilyValue, typeof familyTierSchema>)
  .strict()

/**
 * The stored values of one preferences version, as `GET` returns them. Every key
 * is always present. Lists come back de-duplicated in the order described per field.
 */
export const preferencesValuesSchema = z
  .object({
    homeCountry: countryCodeSchema,
    timeZone: z.string().min(1),
    latestWorkHour: z.string().refine(isLatestWorkHour),
    /** Home country first, then the others in saved order. Always holds the home country. */
    workAuthorizedCountries: z.array(countryCodeSchema).min(1),
    remoteAccepted: z.boolean(),
    relocationAccepted: z.boolean(),
    sponsorshipNeededForRelocation: z.boolean(),
    /** Never holds the home country. */
    excludedRelocationCountries: z.array(countryCodeSchema),
    /** Catalog order. */
    excludedIndustries: z.array(industryKeySchema),
    payFloor: payFloorSchema,
    preferredPay: preferredPaySchema,
    /** Every `roleFamilySchema` key; at least one is not `excluded`. */
    roleFamilyTiers: roleFamilyTiersSchema,
    /** Display form (trimmed, as typed). Null means no keyword rule. */
    titleKeyword: z.string().min(1).max(TITLE_KEYWORD_MAX_LENGTH).nullable(),
    /** At least one; catalog order. */
    seniorityLevels: z.array(seniorityLevelSchema).min(1),
    /** At least one; catalog order. */
    employmentTypes: z.array(employmentTypeSchema).min(1),
    dailyCap: z.int().min(1).max(5),
    /** Trimmed, saved order. */
    emphasisThemes: z.array(z.string().min(1)).max(EMPHASIS_THEMES_MAX),
  })
  .strict()
export type PreferencesValues = z.infer<typeof preferencesValuesSchema>

/**
 * The defaults `GET` returns when the Candidate has no record (an invitee before
 * wizard step 3). Home country, time zone and both pay amounts have no default.
 * The values come from this one constant (`STEP3_DEFAULTS`); clients must not hard-code them.
 */
export const preferencesDefaultsSchema = preferencesValuesSchema
  .extend({
    homeCountry: z.null(),
    timeZone: z.null(),
    workAuthorizedCountries: z.array(countryCodeSchema).max(0),
    payFloor: z.null(),
    preferredPay: z.null(),
  })
  .strict()
export type PreferencesDefaults = z.infer<typeof preferencesDefaultsSchema>

export const STEP3_DEFAULTS: PreferencesDefaults = Object.freeze({
  homeCountry: null,
  timeZone: null,
  latestWorkHour: DEFAULT_LATEST_WORK_HOUR,
  workAuthorizedCountries: [],
  remoteAccepted: true,
  relocationAccepted: true,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: [],
  excludedIndustries: [],
  payFloor: null,
  preferredPay: null,
  roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS },
  titleKeyword: null,
  seniorityLevels: [...seniorityLevelSchema.options],
  employmentTypes: [...employmentTypeSchema.options],
  dailyCap: 5,
  emphasisThemes: [],
})

/**
 * PRD r4 AC 5 (E1): region names from the api's fixed region table. Only the
 * Location rule and the C-PREF-REGIONS note read them; regions are never chosen.
 */
export const regionKeySchema = z.enum([
  "africa", "emea", "europe", "eu", "middle_east", "north_america", "americas", "latam", "apac", "asia", "uk", "us",
])
export type RegionKey = z.infer<typeof regionKeySchema>

/** `GET`/`PUT /v1/me/preferences` 200 body when a record exists. */
export const preferencesRecordResponseSchema = z
  .object({
    version: z.int().positive(),
    savedAt: z.iso.datetime({ offset: true }),
    /** D41: null when a time zone change is allowed now; else the first instant a change is accepted. */
    timeZoneLockedUntil: z.iso.datetime({ offset: true }).nullable(),
    /** Regions in the table that include the home country or a work-authorized country, table order. */
    matchedRegions: z.array(regionKeySchema),
    values: preferencesValuesSchema,
  })
  .strict()

/** `GET /v1/me/preferences` 200 body when no record exists. Nothing is written by the read. */
export const preferencesNoRecordResponseSchema = z
  .object({
    version: z.null(),
    savedAt: z.null(),
    timeZoneLockedUntil: z.null(),
    matchedRegions: z.array(regionKeySchema).max(0),
    values: preferencesDefaultsSchema,
  })
  .strict()

export const preferencesResponseSchema = z.union([preferencesRecordResponseSchema, preferencesNoRecordResponseSchema])
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>

/** One field-level problem on `400 bad_request` from `PUT /v1/me/preferences`. Never echoes a value. */
export const preferencesFieldSchema = z.enum([
  "homeCountry",
  "timeZone",
  "latestWorkHour",
  "workAuthorizedCountries",
  /** `remoteAccepted` and `relocationAccepted` together. */
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
])
export type PreferencesField = z.infer<typeof preferencesFieldSchema>

export const preferencesFieldProblemSchema = z.enum([
  /** Missing, wrong type, or a value outside the field's rule. */
  "invalid",
  /** A country not in `SUPPORTED_COUNTRIES`. */
  "unsupported_country",
  /** Work authorization without the home country. */
  "home_country_missing",
  /** The home country in excluded relocation countries. */
  "home_country_excluded",
  /** An empty list that needs one entry, or neither remote nor relocation. */
  "none_selected",
  /** Every family `excluded`. */
  "no_family_tiered",
  "unknown_entry",
  "too_many_entries",
  "entry_empty",
  "entry_too_long",
  "control_characters",
  "too_long",
])
export type PreferencesFieldProblem = z.infer<typeof preferencesFieldProblemSchema>

export const preferencesFieldErrorSchema = z
  .object({
    field: preferencesFieldSchema,
    /** 1-based list position; null means the whole field. */
    position: z.int().positive().nullable(),
    problem: preferencesFieldProblemSchema,
  })
  .strict()
export type PreferencesFieldError = z.infer<typeof preferencesFieldErrorSchema>

/** The exact `values` keys a `PUT` must send, no more and no fewer. */
export const PREFERENCES_VALUE_KEYS = Object.freeze(Object.keys(preferencesValuesSchema.shape) as (keyof PreferencesValues)[])

export type PreferencesParseResult =
  | Readonly<{ ok: true; baseVersion: number | null; values: PreferencesValues }>
  /** `fieldErrors` empty: a plain `400 bad_request` (body shape, unknown key, missing `baseVersion`). */
  | Readonly<{ ok: false; fieldErrors: readonly PreferencesFieldError[] }>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Validates a `PUT /v1/me/preferences` body and normalises it to the stored
 * values. The api and the web MSW fake both call this one function, so the field
 * errors cannot drift (CR-07). Errors are in `PREFERENCES_VALUE_KEYS` order, one
 * per field and position, first problem found. Any error refuses the whole save.
 */
export function parsePreferencesRequest(body: unknown): PreferencesParseResult {
  const plain = { ok: false, fieldErrors: [] } as const
  if (!isRecord(body)) return plain
  const bodyKeys = Object.keys(body)
  if (bodyKeys.some((key) => key !== "baseVersion" && key !== "values") || !("baseVersion" in body) || !("values" in body)) return plain
  const baseVersion = body.baseVersion
  if (baseVersion !== null && !(typeof baseVersion === "number" && Number.isInteger(baseVersion) && baseVersion >= 1)) return plain
  const v = body.values
  if (!isRecord(v)) return plain
  if (Object.keys(v).some((key) => !(PREFERENCES_VALUE_KEYS as readonly string[]).includes(key))) return plain

  const errors: PreferencesFieldError[] = []
  const fail = (field: PreferencesField, problem: PreferencesFieldProblem, position: number | null = null) => {
    errors.push({ field, position, problem })
  }
  const country = (value: unknown) => countryCodeSchema.safeParse(value)

  const home = country(v.homeCountry)
  if (!home.success) fail("homeCountry", typeof v.homeCountry === "string" && v.homeCountry !== "" ? "unsupported_country" : "invalid")
  if (!isIanaTimeZone(v.timeZone)) fail("timeZone", "invalid")
  if (!isLatestWorkHour(v.latestWorkHour)) fail("latestWorkHour", "invalid")

  const countryList = (field: PreferencesField, value: unknown): CountryCode[] | null => {
    if (!Array.isArray(value)) return (fail(field, "invalid"), null)
    const out: CountryCode[] = []
    let bad = false
    value.forEach((entry, index) => {
      const parsed = country(entry)
      if (!parsed.success) {
        fail(field, typeof entry === "string" ? "unsupported_country" : "invalid", index + 1)
        bad = true
      } else if (!out.includes(parsed.data)) out.push(parsed.data)
    })
    return bad ? null : out
  }
  const authorized = countryList("workAuthorizedCountries", v.workAuthorizedCountries)
  if (authorized && home.success && !authorized.includes(home.data)) fail("workAuthorizedCountries", "home_country_missing")

  if (typeof v.remoteAccepted !== "boolean" || typeof v.relocationAccepted !== "boolean") fail("workArrangement", "invalid")
  else if (!v.remoteAccepted && !v.relocationAccepted) fail("workArrangement", "none_selected")
  if (typeof v.sponsorshipNeededForRelocation !== "boolean") fail("sponsorshipNeededForRelocation", "invalid")

  const excludedCountries = countryList("excludedRelocationCountries", v.excludedRelocationCountries)
  if (excludedCountries && home.success && excludedCountries.includes(home.data)) {
    fail("excludedRelocationCountries", "home_country_excluded", excludedCountries.indexOf(home.data) + 1)
  }

  const industries = catalogList("excludedIndustries", v.excludedIndustries, industryKeySchema.options, false, fail)

  const pay = (value: unknown, prefix: "payFloor" | "preferredPay", basis: "gross" | "net") => {
    if (!isRecord(value) || Object.keys(value).some((key) => !["amount", "currency", "period", "basis"].includes(key)) || value.basis !== basis) {
      fail(`${prefix}Amount`, "invalid")
      return null
    }
    const amount = normalisePayAmount(value.amount)
    const currency = payCurrencySchema.safeParse(value.currency)
    const period = z.enum(["month", "year"]).safeParse(value.period)
    if (amount === null) fail(`${prefix}Amount`, "invalid")
    if (!currency.success) fail(`${prefix}Currency`, "invalid")
    if (!period.success) fail(`${prefix}Period`, "invalid")
    return amount !== null && currency.success && period.success ? { amount, currency: currency.data, period: period.data, basis } : null
  }
  const payFloor = pay(v.payFloor, "payFloor", "gross")
  const preferredPay = pay(v.preferredPay, "preferredPay", "net")

  const tiers = roleFamilyTiersSchema.safeParse(v.roleFamilyTiers)
  if (!tiers.success) fail("roleFamilyTiers", "invalid")
  else if (Object.values(tiers.data).every((tier) => tier === "excluded")) fail("roleFamilyTiers", "no_family_tiered")

  let titleKeyword: string | null = null
  if (v.titleKeyword !== null) {
    if (typeof v.titleKeyword !== "string") fail("titleKeyword", "invalid")
    else if (hasNonWhitespaceControl(v.titleKeyword)) fail("titleKeyword", "control_characters")
    else {
      const trimmed = v.titleKeyword.trim()
      // UTF-16 code units, the unit the browser's maxlength counts (slice 8 rule).
      if (trimmed.length > TITLE_KEYWORD_MAX_LENGTH) fail("titleKeyword", "too_long")
      else titleKeyword = trimmed === "" || keywordFoldsToEmpty(trimmed) ? null : trimmed
    }
  }

  const seniority = catalogList("seniorityLevels", v.seniorityLevels, seniorityLevelSchema.options, true, fail)
  const employment = catalogList("employmentTypes", v.employmentTypes, employmentTypeSchema.options, true, fail)
  if (!(typeof v.dailyCap === "number" && Number.isInteger(v.dailyCap) && v.dailyCap >= 1 && v.dailyCap <= 5)) fail("dailyCap", "invalid")

  const themes: string[] = []
  if (!Array.isArray(v.emphasisThemes)) fail("emphasisThemes", "invalid")
  else if (v.emphasisThemes.length > EMPHASIS_THEMES_MAX) fail("emphasisThemes", "too_many_entries")
  else {
    v.emphasisThemes.forEach((entry, index) => {
      if (typeof entry !== "string") return fail("emphasisThemes", "invalid", index + 1)
      const trimmed = entry.trim()
      if (trimmed === "") return fail("emphasisThemes", "entry_empty", index + 1)
      if (hasNonWhitespaceControl(trimmed)) return fail("emphasisThemes", "control_characters", index + 1)
      if ([...trimmed].length > EMPHASIS_THEME_MAX_LENGTH) return fail("emphasisThemes", "entry_too_long", index + 1)
      themes.push(trimmed)
    })
  }

  if (errors.length > 0) return { ok: false, fieldErrors: dedupe(errors) }
  const homeCode = (home as { data: CountryCode }).data
  return {
    ok: true,
    baseVersion: baseVersion as number | null,
    values: {
      homeCountry: homeCode,
      timeZone: v.timeZone as string,
      latestWorkHour: v.latestWorkHour as string,
      workAuthorizedCountries: [homeCode, ...authorized!.filter((code) => code !== homeCode)],
      remoteAccepted: v.remoteAccepted as boolean,
      relocationAccepted: v.relocationAccepted as boolean,
      sponsorshipNeededForRelocation: v.sponsorshipNeededForRelocation as boolean,
      excludedRelocationCountries: excludedCountries!,
      excludedIndustries: industries!,
      payFloor: payFloor as PayFloor,
      preferredPay: preferredPay as PreferredPay,
      roleFamilyTiers: tiers.data!,
      titleKeyword,
      seniorityLevels: seniority!,
      employmentTypes: employment!,
      dailyCap: v.dailyCap as number,
      emphasisThemes: themes,
    },
  }
}

function catalogList<T extends string>(
  field: PreferencesField,
  value: unknown,
  catalog: readonly T[],
  required: boolean,
  fail: (field: PreferencesField, problem: PreferencesFieldProblem, position?: number | null) => void
): T[] | null {
  if (!Array.isArray(value)) return (fail(field, "invalid"), null)
  let bad = false
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !catalog.includes(entry as T)) {
      fail(field, typeof entry === "string" ? "unknown_entry" : "invalid", index + 1)
      bad = true
    }
  })
  if (bad) return null
  if (required && value.length === 0) return (fail(field, "none_selected"), null)
  return catalog.filter((key) => value.includes(key))
}

function dedupe(errors: PreferencesFieldError[]): PreferencesFieldError[] {
  // The contract table's field order (preferencesFieldSchema), so pay subfields sit where the pay objects are.
  const order = new Map<string, number>(preferencesFieldSchema.options.map((key, index) => [key, index]))
  const seen = new Set<string>()
  return errors
    .filter((error) => {
      const key = `${error.field}:${error.position ?? ""}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (order.get(a.field)! - order.get(b.field)!) || ((a.position ?? 0) - (b.position ?? 0)))
}

/** `PUT /v1/me/preferences` body type. `baseVersion` is required and nullable: `null` only for the first save. */
export type PreferencesRequest = Readonly<{ baseVersion: number | null; values: Record<keyof PreferencesValues, unknown> }>

/** D40: one immutable version of the session Candidate's own preferences. */
export const preferencesVersionSchema = z
  .object({
    version: z.int().positive(),
    savedAt: z.iso.datetime({ offset: true }),
    values: preferencesValuesSchema,
  })
  .strict()
export type PreferencesVersion = z.infer<typeof preferencesVersionSchema>

/** `GET /v1/me/preferences/versions` query: `limit` 1 to 100 (default 50); `before` returns versions below it. */
export const preferencesVersionsQuerySchema = z
  .object({
    limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.int().min(1).max(PREFERENCES_VERSIONS_MAX_LIMIT)).default(PREFERENCES_VERSIONS_DEFAULT_LIMIT),
    before: z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(z.int().min(1).max(2_147_483_647)).nullable().default(null),
  })
  .strict()

export const preferencesVersionsResponseSchema = z
  .object({
    /** Newest first. Empty when the Candidate has no record. */
    versions: z.array(preferencesVersionSchema).max(PREFERENCES_VERSIONS_MAX_LIMIT),
    /** Pass as `before` for the next page; null on the last page. */
    nextBefore: z.int().positive().nullable(),
  })
  .strict()
export type PreferencesVersionsResponse = z.infer<typeof preferencesVersionsResponseSchema>
