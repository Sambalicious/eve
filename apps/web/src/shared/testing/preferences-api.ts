import {
  CSRF_HEADER,
  ME_PREFERENCES_PATH,
  parsePreferencesRequest,
  PREFERENCES_SAVE_LIMIT,
  preferencesRecordResponseSchema,
  preferencesResponseSchema,
  STEP3_DEFAULTS,
  TIME_ZONE_CHANGE_INTERVAL_HOURS,
  type ApiErrorResponse,
  type CountryCode,
  type PreferencesValues,
  type RegionKey,
} from "@eve/contracts"
import { http, HttpResponse, type JsonBodyType } from "msw"

import { apiErrorResponse, TEST_CSRF_TOKEN } from "./contract-handlers"

/**
 * An in-memory stand-in for `GET`/`PUT /v1/me/preferences` (contract v1.23.0,
 * EPIC-0002 B1). The PUT runs the contract's own `parsePreferencesRequest`, so
 * field errors come from the same function the api calls (CR-07). Order of checks
 * follows the contract: CSRF, save limit, body shape and fields, version, time
 * zone limit (D41), write. Every body is parsed with the contract schema.
 */
export interface PreferencesRecord {
  version: number
  savedAt: string
  /** When the last accepted save changed the time zone; null for the first set. */
  timeZoneChangedAt: string | null
  values: PreferencesValues
}

export interface PreferencesApiState {
  /** Null: no record yet (an invitee before step 3); GET returns `STEP3_DEFAULTS`. */
  record: PreferencesRecord | null
  /** Accepted attempts in the current window (PreferencesSaveLimiter); 429 once over the limit. */
  attempts: number
  /** Forces the next PUT to fail this way, once. */
  nextSave: "internal_error" | "network" | "too_many_requests" | "csrf_invalid" | null
  /** Designer preview: another tab saves before every PUT, so each save is stale until reload. */
  staleEverySave?: boolean
  /** Fixed clock for D41 and `savedAt`. */
  now: () => Date
}

/**
 * Fixture region table: test data standing in for the api's region table. Only
 * the `C-PREF-REGIONS` note reads `matchedRegions`; the web never computes it.
 */
const REGION_FIXTURE: Readonly<Partial<Record<CountryCode, readonly RegionKey[]>>> = {
  NG: ["africa", "emea"],
  GH: ["africa", "emea"],
  KE: ["africa", "emea"],
  ZA: ["africa", "emea"],
  EG: ["africa", "emea", "middle_east"],
  DE: ["emea", "europe", "eu"],
  GB: ["emea", "europe", "uk"],
  US: ["north_america", "americas", "us"],
}
const REGION_ORDER: readonly RegionKey[] = ["africa", "emea", "europe", "eu", "middle_east", "north_america", "americas", "latam", "apac", "asia", "uk", "us"]

export function matchedRegionsFor(values: Pick<PreferencesValues, "homeCountry" | "workAuthorizedCountries">): RegionKey[] {
  const hit = new Set([values.homeCountry, ...values.workAuthorizedCountries].flatMap((code) => REGION_FIXTURE[code] ?? []))
  return REGION_ORDER.filter((key) => hit.has(key))
}

/** A saved Kofi-like record: Kenya, version 1, every list default. */
export function savedPreferences(overrides: Partial<PreferencesValues> = {}): PreferencesValues {
  return {
    ...STEP3_DEFAULTS,
    homeCountry: "KE",
    timeZone: "Africa/Nairobi",
    workAuthorizedCountries: ["KE"],
    payFloor: { amount: "3000.00", currency: "USD", period: "month", basis: "gross" },
    preferredPay: { amount: "4500.00", currency: "USD", period: "month", basis: "net" },
    roleFamilyTiers: { ...STEP3_DEFAULTS.roleFamilyTiers },
    seniorityLevels: [...STEP3_DEFAULTS.seniorityLevels],
    employmentTypes: [...STEP3_DEFAULTS.employmentTypes],
    ...overrides,
  }
}

export function preferencesRecord(version = 1, overrides: Partial<PreferencesValues> = {}): PreferencesRecord {
  return { version, savedAt: "2026-10-27T09:00:00.000Z", timeZoneChangedAt: null, values: savedPreferences(overrides) }
}

export function createPreferencesApi(initial: Partial<PreferencesApiState> = {}) {
  const state: PreferencesApiState = {
    record: preferencesRecord(),
    attempts: 0,
    nextSave: null,
    now: () => new Date("2026-10-28T12:00:00.000Z"),
    ...initial,
  }
  const puts: unknown[] = []

  const lockedUntil = (record: PreferencesRecord): string | null => {
    if (record.timeZoneChangedAt === null) return null
    const until = new Date(new Date(record.timeZoneChangedAt).getTime() + TIME_ZONE_CHANGE_INTERVAL_HOURS * 3_600_000)
    return until > state.now() ? until.toISOString() : null
  }
  const recordBody = (record: PreferencesRecord) =>
    preferencesRecordResponseSchema.parse({
      version: record.version,
      savedAt: record.savedAt,
      timeZoneLockedUntil: lockedUntil(record),
      matchedRegions: matchedRegionsFor(record.values),
      values: record.values,
    })
  const errorBody = (status: number, error: ApiErrorResponse["error"]) => HttpResponse.json({ error } as JsonBodyType, { status })

  const handlers = [
    http.get(ME_PREFERENCES_PATH, () => {
      const body = state.record
        ? recordBody(state.record)
        : { version: null, savedAt: null, timeZoneLockedUntil: null, matchedRegions: [], values: STEP3_DEFAULTS }
      return HttpResponse.json(preferencesResponseSchema.parse(body) as JsonBodyType, { headers: { "cache-control": "no-store" } })
    }),
    http.put(ME_PREFERENCES_PATH, async ({ request }) => {
      if (request.headers.get(CSRF_HEADER) !== TEST_CSRF_TOKEN) return apiErrorResponse("csrf_invalid")
      const body: unknown = await request.json().catch(() => undefined)
      puts.push(body)
      const forced = state.nextSave
      state.nextSave = null
      if (forced === "network") return HttpResponse.error()
      if (forced === "too_many_requests" || state.attempts >= PREFERENCES_SAVE_LIMIT) {
        const response = apiErrorResponse("too_many_requests")
        response.headers.set("retry-after", "42")
        return response
      }
      state.attempts += 1
      if (forced) return apiErrorResponse(forced)
      const parsed = parsePreferencesRequest(body)
      if (!parsed.ok) {
        return parsed.fieldErrors.length === 0
          ? apiErrorResponse("bad_request")
          : errorBody(400, { code: "bad_request", message: "The request is not valid.", fieldErrors: [...parsed.fieldErrors] })
      }
      if (state.staleEverySave && state.record) state.record = { ...state.record, version: state.record.version + 1 }
      const current = state.record
      if (parsed.baseVersion !== (current?.version ?? null)) {
        return errorBody(409, {
          code: "preferences_stale",
          message: "Your preferences changed in another tab. Reload to see the latest.",
          currentVersion: current?.version ?? null,
        })
      }
      const changesZone = current !== null && current.values.timeZone !== parsed.values.timeZone
      if (changesZone && current) {
        const until = lockedUntil(current)
        if (until) {
          return errorBody(409, { code: "timezone_change_rate_limited", message: "You can change your time zone once a day.", timeZoneLockedUntil: until })
        }
      }
      const now = state.now().toISOString()
      state.record = {
        version: (current?.version ?? 0) + 1,
        savedAt: now,
        timeZoneChangedAt: changesZone ? now : (current?.timeZoneChangedAt ?? null),
        values: parsed.values,
      }
      return HttpResponse.json(recordBody(state.record) as JsonBodyType)
    }),
  ]

  /** Another tab saved: bump the stored version so this tab's base is stale. */
  const saveElsewhere = (overrides: Partial<PreferencesValues> = {}) => {
    const current = state.record ?? preferencesRecord(0)
    state.record = { ...current, version: current.version + 1, values: { ...current.values, ...overrides } }
  }

  return { state, handlers, puts, saveElsewhere }
}

export type PreferencesApi = ReturnType<typeof createPreferencesApi>

/** Default handlers: a saved record with no excluded family and no keyword (the migrated Operator's shape). */
export const freshPreferencesHandlers = createPreferencesApi().handlers
