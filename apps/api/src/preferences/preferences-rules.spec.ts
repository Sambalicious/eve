import { DEFAULT_ROLE_FAMILY_TIERS, type PreferencesValues, SUPPORTED_COUNTRIES, regionKeySchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import {
  BASE_VERSION_MAX,
  PREFERENCES_LIST_MAX,
  matchedRegions,
  parseSaveBody,
  timeZoneLockedUntil,
} from "./preferences-rules.js"

const VALUES: PreferencesValues = {
  homeCountry: "KE",
  timeZone: "Africa/Nairobi",
  latestWorkHour: "23:00",
  workAuthorizedCountries: ["KE"],
  remoteAccepted: true,
  relocationAccepted: true,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: [],
  excludedIndustries: [],
  payFloor: { amount: "4000.00", currency: "EUR", period: "month", basis: "gross" },
  preferredPay: { amount: "5500.00", currency: "EUR", period: "month", basis: "net" },
  roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS },
  titleKeyword: null,
  seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
  employmentTypes: ["direct", "employer_of_record", "contract"],
  dailyCap: 3,
  emphasisThemes: [],
}

describe("parseSaveBody: bounds before validation (F-TM-01, F-TM-02)", () => {
  it("accepts a valid first save and a valid later save", () => {
    expect(parseSaveBody({ baseVersion: null, values: VALUES })).toMatchObject({ kind: "ok", baseVersion: null })
    expect(parseSaveBody({ baseVersion: 7, values: VALUES })).toMatchObject({ kind: "ok", baseVersion: 7 })
  })

  it("F-TM-01: a baseVersion above 2,147,483,647 is a plain 400, not a field error or a database error", () => {
    expect(BASE_VERSION_MAX).toBe(2_147_483_647)
    expect(parseSaveBody({ baseVersion: BASE_VERSION_MAX, values: VALUES })).toMatchObject({ kind: "ok" })
    expect(parseSaveBody({ baseVersion: BASE_VERSION_MAX + 1, values: VALUES })).toEqual({ kind: "bad_request" })
    expect(parseSaveBody({ baseVersion: 1e300, values: VALUES })).toEqual({ kind: "bad_request" })
  })

  it.each(["workAuthorizedCountries", "excludedRelocationCountries", "excludedIndustries", "seniorityLevels", "employmentTypes", "emphasisThemes"])(
    "F-TM-02: %s longer than the list cap is a plain 400 before any per-entry error is built",
    (field) => {
      const long = Array.from({ length: PREFERENCES_LIST_MAX + 1 }, () => 123)
      expect(parseSaveBody({ baseVersion: null, values: { ...VALUES, [field]: long } })).toEqual({ kind: "bad_request" })
    }
  )

  it("F-TM-02: a list at the cap is validated as usual (one error per bad position)", () => {
    const atCap = Array.from({ length: PREFERENCES_LIST_MAX }, () => 123)
    const result = parseSaveBody({ baseVersion: null, values: { ...VALUES, excludedIndustries: atCap } })
    expect(result.kind).toBe("field_errors")
    if (result.kind === "field_errors") expect(result.fieldErrors).toHaveLength(PREFERENCES_LIST_MAX)
  })

  it("the cap leaves every real list well inside it", () => {
    expect(PREFERENCES_LIST_MAX).toBeGreaterThanOrEqual(Object.keys(SUPPORTED_COUNTRIES).length * 2)
  })

  it("field errors pass through, and shape errors stay plain", () => {
    expect(parseSaveBody({ baseVersion: null, values: { ...VALUES, dailyCap: 9 } })).toEqual({ kind: "field_errors", fieldErrors: [{ field: "dailyCap", position: null, problem: "invalid" }] })
    expect(parseSaveBody({ values: VALUES })).toEqual({ kind: "bad_request" })
    expect(parseSaveBody([1, 2])).toEqual({ kind: "bad_request" })
  })
})

describe("matchedRegions (PRD r4 AC 5 region table, C-PREF-REGIONS)", () => {
  it("Kenya is in Africa and EMEA only, in table order", () => {
    expect(matchedRegions({ homeCountry: "KE", workAuthorizedCountries: ["KE"] })).toEqual(["africa", "emea"])
  })

  it("adds the regions of every work-authorized country, de-duplicated, in table order", () => {
    expect(matchedRegions({ homeCountry: "NG", workAuthorizedCountries: ["NG", "GB", "US"] })).toEqual(["africa", "emea", "europe", "north_america", "americas", "uk", "us"])
    expect(matchedRegions({ homeCountry: "DE", workAuthorizedCountries: ["DE"] })).toEqual(["emea", "europe", "eu"])
    expect(matchedRegions({ homeCountry: "EG", workAuthorizedCountries: ["EG"] })).toEqual(["africa", "emea", "middle_east"])
    expect(matchedRegions({ homeCountry: "SG", workAuthorizedCountries: ["SG"] })).toEqual(["apac", "asia"])
  })

  it("every supported country is in at least one region, and only region keys come back", () => {
    for (const code of Object.keys(SUPPORTED_COUNTRIES)) {
      const regions = matchedRegions({ homeCountry: code, workAuthorizedCountries: [code] })
      expect(regions.length, code).toBeGreaterThan(0)
      for (const region of regions) expect(regionKeySchema.options).toContain(region)
    }
  })
})

describe("timeZoneLockedUntil (D41)", () => {
  const at = (iso: string) => new Date(iso)

  it("no change yet (only the first set) starts no limit", () => {
    expect(timeZoneLockedUntil(null, at("2026-10-23T09:05:00Z"))).toBeNull()
  })

  it("a change locks for 24 hours from that change; at exactly 24 hours it is open", () => {
    const change = at("2026-10-23T09:00:00Z")
    expect(timeZoneLockedUntil(change, at("2026-10-23T11:00:00Z"))?.toISOString()).toBe("2026-10-24T09:00:00.000Z")
    expect(timeZoneLockedUntil(change, at("2026-10-24T08:59:59.999Z"))?.toISOString()).toBe("2026-10-24T09:00:00.000Z")
    expect(timeZoneLockedUntil(change, at("2026-10-24T09:00:00Z"))).toBeNull()
  })
})
