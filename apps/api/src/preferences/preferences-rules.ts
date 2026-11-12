import {
  type PreferencesFieldError,
  type PreferencesValues,
  type RegionKey,
  TIME_ZONE_CHANGE_INTERVAL_HOURS,
  parsePreferencesRequest,
  regionKeySchema,
} from "@eve/contracts"

import { REGION_MEMBERS } from "../discovery/rules/places.js"

/**
 * Pure rules for `PUT`/`GET /v1/me/preferences` (api-contract-b1 v1.25.0).
 * No I/O: the repository and the controller call these.
 */

/** F-TM-01 (TM-B1-04): the largest `integer` Postgres stores. A larger `baseVersion` is a plain 400, never a database error. */
export const BASE_VERSION_MAX = 2_147_483_647

/**
 * F-TM-02 (TM-B1-12): a list longer than this is a plain 400 before any
 * per-entry field error is built, so one 1 MiB body cannot produce ~100k
 * errors. Every real list is far shorter (28 countries, 7 industries, 5
 * levels, 3 types, 3 themes).
 */
export const PREFERENCES_LIST_MAX = 64

const LIST_FIELDS = ["workAuthorizedCountries", "excludedRelocationCountries", "excludedIndustries", "seniorityLevels", "employmentTypes", "emphasisThemes"] as const

export type SaveBody =
  | Readonly<{ kind: "ok"; baseVersion: number | null; values: PreferencesValues }>
  | Readonly<{ kind: "field_errors"; fieldErrors: readonly PreferencesFieldError[] }>
  | Readonly<{ kind: "bad_request" }>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Bounds first (F-TM-01, F-TM-02), then the shared contract parser (`parsePreferencesRequest`). */
export function parseSaveBody(body: unknown): SaveBody {
  if (isRecord(body)) {
    if (typeof body.baseVersion === "number" && body.baseVersion > BASE_VERSION_MAX) return { kind: "bad_request" }
    if (isRecord(body.values)) {
      const values = body.values
      if (LIST_FIELDS.some((field) => Array.isArray(values[field]) && (values[field] as unknown[]).length > PREFERENCES_LIST_MAX)) return { kind: "bad_request" }
    }
  }
  const parsed = parsePreferencesRequest(body)
  if (parsed.ok) return { kind: "ok", baseVersion: parsed.baseVersion, values: parsed.values }
  return parsed.fieldErrors.length > 0 ? { kind: "field_errors", fieldErrors: parsed.fieldErrors } : { kind: "bad_request" }
}

/** C-PREF-REGIONS: regions holding the home country or a work-authorized country, in table order. One table with the location rule (`places.ts`, B1 unit 4b). */
export function matchedRegions(values: Readonly<{ homeCountry: string; workAuthorizedCountries: readonly string[] }>): RegionKey[] {
  const countries = new Set<string>([values.homeCountry, ...values.workAuthorizedCountries])
  return regionKeySchema.options.filter((region) => REGION_MEMBERS[region].some((code) => countries.has(code)))
}

/**
 * D41: given when the last accepted save that changed the time zone was made
 * (null when only the first set exists), the first instant another change is
 * accepted, or null when a change is accepted now. Exactly 24 hours is open.
 */
export function timeZoneLockedUntil(lastChangeAt: Date | null, now: Date): Date | null {
  if (lastChangeAt === null) return null
  const until = new Date(lastChangeAt.getTime() + TIME_ZONE_CHANGE_INTERVAL_HOURS * 3_600_000)
  return now.getTime() < until.getTime() ? until : null
}
