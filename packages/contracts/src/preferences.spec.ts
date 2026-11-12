import { describe, expect, it } from "vitest"

import { postingsTabSchema, roleFamilySchema, skipReasonSchema } from "./discovery.js"
import { apiErrorCodeSchema, apiErrorResponseSchema } from "./errors.js"
import {
  DEFAULT_ROLE_FAMILY_TIERS,
  ME_PREFERENCES_PATH,
  ME_PREFERENCES_VERSIONS_PATH,
  PAY_CURRENCIES,
  PREFERENCES_SAVE_LIMIT,
  PREFERENCES_SAVE_WINDOW_SECONDS,
  PREFERENCES_VALUE_KEYS,
  STEP3_DEFAULTS,
  SUPPORTED_COUNTRIES,
  TIME_ZONE_CHANGE_INTERVAL_HOURS,
  isIanaTimeZone,
  isLatestWorkHour,
  parsePreferencesRequest,
  preferencesDefaultsSchema,
  preferencesNoRecordResponseSchema,
  preferencesRecordResponseSchema,
  preferencesResponseSchema,
  preferencesVersionsQuerySchema,
  preferencesVersionsResponseSchema,
} from "./preferences.js"

/**
 * EPIC-0002 B1, contract v1.25.0 (D19: main took v1.22.0 for EPIC-0008, v1.23.0 for apply anyway and v1.23.1 for EPIC-0008 hardening). Expected
 * values are copied from the handoff (api-contract.md "EPIC-0002 B1"), not from the schemas.
 */
const VALID = {
  homeCountry: "KE",
  timeZone: "Africa/Nairobi",
  latestWorkHour: "23:00",
  workAuthorizedCountries: ["ZA", "KE"],
  remoteAccepted: true,
  relocationAccepted: false,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: ["EG"],
  excludedIndustries: ["betting", "adult_content"],
  payFloor: { amount: "4000", currency: "EUR", period: "month", basis: "gross" },
  preferredPay: { amount: 5500.5, currency: "EUR", period: "month", basis: "net" },
  roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, people_management: "excluded" },
  titleKeyword: "  Réact  ",
  seniorityLevels: ["staff", "senior"],
  employmentTypes: ["direct"],
  dailyCap: 3,
  emphasisThemes: [" scaling Postgres "],
} as const

const put = (values: Record<string, unknown>, baseVersion: number | null = 4) => parsePreferencesRequest({ baseVersion, values })
const errorsOf = (values: Record<string, unknown>) => {
  const result = put(values)
  return result.ok ? [] : result.fieldErrors
}

describe("v1.25.0 paths, limits and enums", () => {
  it("paths and limits", () => {
    expect(ME_PREFERENCES_PATH).toBe("/v1/me/preferences")
    expect(ME_PREFERENCES_VERSIONS_PATH).toBe("/v1/me/preferences/versions")
    expect([PREFERENCES_SAVE_LIMIT, PREFERENCES_SAVE_WINDOW_SECONDS, TIME_ZONE_CHANGE_INTERVAL_HOURS]).toEqual([10, 60, 24])
  })

  it("adds two error codes, two skip reasons and the excluded_family tab (plus the manual tab in v1.28.0)", () => {
    // v1.27.0 (EPIC-0010) appends nine codes, v1.28.0 (EPIC-0011) one more and v1.31.0 (EPIC-0014) one more after these two.
    expect(apiErrorCodeSchema.options.slice(-13, -11)).toEqual(["preferences_stale", "timezone_change_rate_limited"])
    expect(skipReasonSchema.options.slice(-2)).toEqual(["excluded_role_family", "keyword_mismatch"])
    expect(postingsTabSchema.options).toEqual(["ranked", "manual", "skipped", "excluded_family", "all"])
    expect(postingsTabSchema.safeParse("excluded").success).toBe(false)
    expect(postingsTabSchema.safeParse("EXCLUDED_FAMILY").success).toBe(false)
  })

  it("supports the five required home countries and every relocation place country", () => {
    for (const code of ["NG", "GH", "KE", "ZA", "EG", "OM", "TR", "JO", "LB", "TH", "DE", "NL", "AE", "CA", "GB", "US", "IE", "PT", "ES", "FR", "PL", "SE", "DK", "NO", "CH", "SG", "SA", "QA"]) {
      expect(SUPPORTED_COUNTRIES, code).toHaveProperty(code)
    }
    expect(SUPPORTED_COUNTRIES.NG).toBe("Africa/Lagos")
    expect(SUPPORTED_COUNTRIES.KE).toBe("Africa/Nairobi")
    for (const zone of Object.values(SUPPORTED_COUNTRIES)) expect(isIanaTimeZone(zone), zone).toBe(true)
  })

  it("pay currencies are the 20 rate-table codes, USD then EUR then by code", () => {
    expect(PAY_CURRENCIES).toHaveLength(20)
    expect(PAY_CURRENCIES.slice(0, 2)).toEqual(["USD", "EUR"])
    expect(PAY_CURRENCIES.slice(2)).toEqual([...PAY_CURRENCIES.slice(2)].sort())
    for (const code of ["NGN", "KES", "GHS", "EGP", "AED", "SAR"]) expect(PAY_CURRENCIES).not.toContain(code)
  })

  it("default tiers cover every role family, none excluded", () => {
    expect(Object.keys(DEFAULT_ROLE_FAMILY_TIERS).sort()).toEqual([...roleFamilySchema.options].sort())
    expect(Object.values(DEFAULT_ROLE_FAMILY_TIERS)).not.toContain("excluded")
  })
})

describe("v1.25.0 GET /v1/me/preferences", () => {
  it("no record: version null and the step 3 defaults", () => {
    const body = { version: null, savedAt: null, timeZoneLockedUntil: null, matchedRegions: [], values: STEP3_DEFAULTS }
    expect(preferencesNoRecordResponseSchema.parse(body)).toEqual(body)
    expect(preferencesResponseSchema.safeParse(body).success).toBe(true)
    expect(preferencesDefaultsSchema.parse(STEP3_DEFAULTS)).toMatchObject({
      latestWorkHour: "23:00",
      sponsorshipNeededForRelocation: true,
      seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
      employmentTypes: ["direct", "employer_of_record", "contract"],
      dailyCap: 5,
      titleKeyword: null,
    })
  })

  it("record: the stored values, version and D41 lock", () => {
    const parsed = put(VALID)
    if (!parsed.ok) throw new Error("expected ok")
    const body = { version: 5, savedAt: "2026-10-23T09:00:00Z", timeZoneLockedUntil: "2026-10-24T09:00:00Z", matchedRegions: ["africa", "emea"], values: parsed.values }
    expect(preferencesRecordResponseSchema.parse(body)).toEqual(body)
    expect(preferencesRecordResponseSchema.safeParse({ ...body, candidateId: "x" }).success).toBe(false)
    expect(preferencesRecordResponseSchema.safeParse({ ...body, values: { ...parsed.values, minCoreMatchPercent: 70 } }).success).toBe(false)
  })
})

describe("v1.25.0 PUT /v1/me/preferences parsing", () => {
  it("normalises a valid body", () => {
    const result = put(VALID)
    expect(result).toEqual({
      ok: true,
      baseVersion: 4,
      values: {
        ...VALID,
        workAuthorizedCountries: ["KE", "ZA"],
        excludedIndustries: ["adult_content", "betting"],
        payFloor: { amount: "4000.00", currency: "EUR", period: "month", basis: "gross" },
        preferredPay: { amount: "5500.50", currency: "EUR", period: "month", basis: "net" },
        titleKeyword: "Réact",
        seniorityLevels: ["senior", "staff"],
        emphasisThemes: ["scaling Postgres"],
      },
    })
  })

  it("baseVersion is required and nullable; extra keys are a plain 400", () => {
    expect(put(VALID, null)).toMatchObject({ ok: true, baseVersion: null })
    expect(parsePreferencesRequest({ values: VALID })).toEqual({ ok: false, fieldErrors: [] })
    expect(parsePreferencesRequest({ baseVersion: 0, values: VALID })).toEqual({ ok: false, fieldErrors: [] })
    expect(parsePreferencesRequest({ baseVersion: 1, values: VALID, candidateId: "x" })).toEqual({ ok: false, fieldErrors: [] })
    expect(put({ ...VALID, minCoreMatchPercent: 70 })).toEqual({ ok: false, fieldErrors: [] })
    expect(parsePreferencesRequest([])).toEqual({ ok: false, fieldErrors: [] })
  })

  it.each([
    [{ homeCountry: "XX" }, "homeCountry", null, "unsupported_country"],
    [{ homeCountry: "" }, "homeCountry", null, "invalid"],
    [{ timeZone: "WAT" }, "timeZone", null, "invalid"],
    [{ timeZone: "GMT+1" }, "timeZone", null, "invalid"],
    [{ timeZone: "africa/nairobi" }, "timeZone", null, "invalid"],
    [{ latestWorkHour: "00:00" }, "latestWorkHour", null, "invalid"],
    [{ latestWorkHour: "24:00" }, "latestWorkHour", null, "invalid"],
    [{ latestWorkHour: "9:5" }, "latestWorkHour", null, "invalid"],
    [{ workAuthorizedCountries: ["ZA"] }, "workAuthorizedCountries", null, "home_country_missing"],
    [{ workAuthorizedCountries: ["KE", "XX"] }, "workAuthorizedCountries", 2, "unsupported_country"],
    [{ remoteAccepted: false, relocationAccepted: false }, "workArrangement", null, "none_selected"],
    [{ sponsorshipNeededForRelocation: "maybe" }, "sponsorshipNeededForRelocation", null, "invalid"],
    [{ excludedRelocationCountries: ["EG", "KE"] }, "excludedRelocationCountries", 2, "home_country_excluded"],
    [{ excludedIndustries: ["fast_food"] }, "excludedIndustries", 1, "unknown_entry"],
    [{ payFloor: { amount: "4000.555", currency: "EUR", period: "month", basis: "gross" } }, "payFloorAmount", null, "invalid"],
    [{ payFloor: { amount: "0.00", currency: "EUR", period: "month", basis: "gross" } }, "payFloorAmount", null, "invalid"],
    [{ payFloor: { amount: "4000", currency: "NGN", period: "month", basis: "gross" } }, "payFloorCurrency", null, "invalid"],
    [{ payFloor: { amount: "4000", currency: "EUR", period: "week", basis: "gross" } }, "payFloorPeriod", null, "invalid"],
    [{ preferredPay: { amount: "0", currency: "EUR", period: "month", basis: "net" } }, "preferredPayAmount", null, "invalid"],
    [{ roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, backend: 4 } }, "roleFamilyTiers", null, "invalid"],
    [{ roleFamilyTiers: Object.fromEntries(roleFamilySchema.options.map((f) => [f, "excluded"])) }, "roleFamilyTiers", null, "no_family_tiered"],
    [{ titleKeyword: "a".repeat(101) }, "titleKeyword", null, "too_long"],
    [{ titleKeyword: "react\u0007" }, "titleKeyword", null, "control_characters"],
    [{ seniorityLevels: [] }, "seniorityLevels", null, "none_selected"],
    [{ employmentTypes: ["internship"] }, "employmentTypes", 1, "unknown_entry"],
    [{ dailyCap: 6 }, "dailyCap", null, "invalid"],
    [{ dailyCap: 2.5 }, "dailyCap", null, "invalid"],
    [{ emphasisThemes: ["a", "b", "c", "d"] }, "emphasisThemes", null, "too_many_entries"],
    [{ emphasisThemes: ["x".repeat(61)] }, "emphasisThemes", 1, "entry_too_long"],
    [{ emphasisThemes: ["   "] }, "emphasisThemes", 1, "entry_empty"],
  ] as const)("%o gives %s/%s %s", (patch, field, position, problem) => {
    expect(errorsOf({ ...VALID, ...patch })).toEqual([{ field, position, problem }])
  })

  it("boundaries are accepted", () => {
    expect(put({ ...VALID, payFloor: { amount: "0.01", currency: "USD", period: "month", basis: "gross" } }).ok).toBe(true)
    expect(put({ ...VALID, emphasisThemes: ["x".repeat(60)] }).ok).toBe(true)
    expect(put({ ...VALID, titleKeyword: "a".repeat(100) }).ok).toBe(true)
    expect(put({ ...VALID, roleFamilyTiers: { ...Object.fromEntries(roleFamilySchema.options.map((f) => [f, "excluded"])), backend: 1 } }).ok).toBe(true)
    for (const hour of ["01:00", "23:59"]) expect(isLatestWorkHour(hour)).toBe(true)
    expect(put({ ...VALID, timeZone: "UTC" }).ok).toBe(true)
  })

  it("a keyword that folds to nothing, or a blank one, is stored as null", () => {
    for (const keyword of ["\u200B", "  \u200B  ", "\u0301", "   "]) {
      expect(put({ ...VALID, titleKeyword: keyword })).toMatchObject({ ok: true, values: { titleKeyword: null } })
    }
    expect(put({ ...VALID, titleKeyword: "re\u200Bact" })).toMatchObject({ ok: true, values: { titleKeyword: "re\u200Bact" } })
  })

  it("the home country is stored once in work authorization", () => {
    expect(put({ ...VALID, workAuthorizedCountries: ["KE", "KE"] })).toMatchObject({ ok: true, values: { workAuthorizedCountries: ["KE"] } })
  })

  it("errors come in field order, one per field", () => {
    expect(errorsOf({ ...VALID, dailyCap: 0, homeCountry: "XX", timeZone: "WAT" }).map((e) => e.field)).toEqual(["homeCountry", "timeZone", "dailyCap"])
  })

  it("pay subfield errors sit in the contract table's order, before roleFamilyTiers and dailyCap", () => {
    const pay = { amount: "0", currency: "NGN", period: "week", basis: "gross" }
    expect(errorsOf({ ...VALID, dailyCap: 9, payFloor: pay, roleFamilyTiers: {} }).map((e) => e.field)).toEqual(["payFloorAmount", "payFloorCurrency", "payFloorPeriod", "roleFamilyTiers", "dailyCap"])
  })

  it("every values key is required", () => {
    expect(PREFERENCES_VALUE_KEYS).toHaveLength(17)
    const rest: Record<string, unknown> = { ...VALID }
    delete rest.dailyCap
    expect(errorsOf(rest)).toEqual([{ field: "dailyCap", position: null, problem: "invalid" }])
  })
})

describe("v1.25.0 error envelope", () => {
  it("preferences_stale carries currentVersion; the time zone limit carries timeZoneLockedUntil", () => {
    expect(apiErrorResponseSchema.safeParse({ error: { code: "preferences_stale", message: "m", currentVersion: 5 } }).success).toBe(true)
    expect(apiErrorResponseSchema.safeParse({ error: { code: "preferences_stale", message: "m", currentVersion: null } }).success).toBe(true)
    expect(apiErrorResponseSchema.safeParse({ error: { code: "timezone_change_rate_limited", message: "m", timeZoneLockedUntil: "2026-10-24T09:00:00Z" } }).success).toBe(true)
    expect(apiErrorResponseSchema.safeParse({ error: { code: "bad_request", message: "m", fieldErrors: [{ field: "dailyCap", position: null, problem: "invalid" }] } }).success).toBe(true)
  })
})

describe("v1.25.0 GET /v1/me/preferences/versions (D40)", () => {
  it("query defaults and bounds", () => {
    expect(preferencesVersionsQuerySchema.parse({})).toEqual({ limit: 50, before: null })
    expect(preferencesVersionsQuerySchema.parse({ limit: "100", before: "7" })).toEqual({ limit: 100, before: 7 })
    for (const bad of [{ limit: "0" }, { limit: "101" }, { limit: "05" }, { before: "0" }, { candidateId: "x" }]) {
      expect(preferencesVersionsQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it("empty list for no record", () => {
    expect(preferencesVersionsResponseSchema.parse({ versions: [], nextBefore: null })).toEqual({ versions: [], nextBefore: null })
  })
})
