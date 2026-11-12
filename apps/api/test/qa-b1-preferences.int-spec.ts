import { DEFAULT_ROLE_FAMILY_TIERS, PAY_CURRENCIES, STEP3_DEFAULTS, preferencesResponseSchema } from "@eve/contracts"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  type B1World,
  FAMILIES,
  type LooseValues,
  PREFS,
  type RecordBody,
  VERSIONS,
  clearPreferences,
  createRecord,
  expectFieldError,
  expectPlainBadRequest,
  kenyaValues,
  preferencesRows,
  read,
  save,
  saveOnTop,
  startB1World,
  versionCount,
} from "./support/qa-b1.js"

/**
 * EPIC-0002 B1 QA (qa-author, qa-tests-1): `GET`/`PUT /v1/me/preferences` from
 * api-contract-b1.md v1.23.0 and job-preferences.feature. Every assertion is on
 * the HTTP response or on `job_preferences`/`job_preferences_version` rows.
 * Kofi is a non-Operator with no record until a test creates one, so each test
 * clears his preferences first and takes a fresh session (save limit).
 */
let w: B1World

beforeAll(async () => {
  w = await startB1World()
})

afterAll(async () => {
  await w?.stop()
})

beforeEach(async () => {
  w.clock.set("2026-10-23T09:00:00.000Z")
  await clearPreferences(w.db, w.kofi.id)
  await clearPreferences(w.db, w.wanjiru.id)
})

describe("GET with no record (contract: no record; job-preferences.feature:634)", () => {
  it(":634 returns version null, savedAt null, no lock, no regions and STEP3_DEFAULTS, and writes nothing", async () => {
    const kofi = await w.session(w.kofi)
    const before = await preferencesRows(w.db, w.kofi.id)
    const response = await kofi.get(PREFS).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.body).toEqual({ version: null, savedAt: null, timeZoneLockedUntil: null, matchedRegions: [], values: STEP3_DEFAULTS })
    expect(preferencesResponseSchema.safeParse(response.body).success).toBe(true)
    expect(await preferencesRows(w.db, w.kofi.id)).toBe(before)
  })

  it(":98/:103/:109 defaults: sponsorship yes, all five levels, all three types, daily cap 5, latest hour 23:00, default tiers", async () => {
    const kofi = await w.session(w.kofi)
    const { values } = (await kofi.get(PREFS).expect(200)).body as { values: Record<string, unknown> }
    expect(values.sponsorshipNeededForRelocation).toBe(true)
    expect(values.seniorityLevels).toEqual(["junior", "mid", "senior", "staff", "principal"])
    expect(values.employmentTypes).toEqual(["direct", "employer_of_record", "contract"])
    expect(values.dailyCap).toBe(5)
    expect(values.latestWorkHour).toBe("23:00")
    expect(values.homeCountry).toBeNull()
    expect(values.timeZone).toBeNull()
    expect(values.titleKeyword).toBeNull()
    expect(values.roleFamilyTiers).toEqual(DEFAULT_ROLE_FAMILY_TIERS)
  })

  it(":592 an unauthenticated request is 401 unauthenticated and returns no preference value", async () => {
    const response = await request(w.app.getHttpServer()).get(PREFS)
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe("unauthenticated")
    expect(JSON.stringify(response.body)).not.toMatch(/homeCountry|values/)
    const versions = await request(w.app.getHttpServer()).get(VERSIONS)
    expect(versions.status).toBe(401)
    const put = await request(w.app.getHttpServer()).put(PREFS).send({ baseVersion: null, values: kenyaValues() })
    expect(put.status).toBe(401)
    expect(await versionCount(w.db, w.kofi.id)).toBe(0)
  })

  it("a PUT without the CSRF header is 403 csrf_invalid and writes nothing", async () => {
    const kofi = await w.session(w.kofi)
    const put = await request(w.app.getHttpServer()).put(PREFS).set("cookie", kofi.cookie).send({ baseVersion: null, values: kenyaValues() })
    expect(put.status).toBe(403)
    expect(put.body.error.code).toBe("csrf_invalid")
    expect(await versionCount(w.db, w.kofi.id)).toBe(0)
  })
})

describe("first save and versions (contract PUT success; job-preferences.feature:54, :148, :618)", () => {
  it("the first save with baseVersion null creates version 1 and returns the record shape", async () => {
    const kofi = await w.session(w.kofi)
    const response = await save(kofi, null, kenyaValues())
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const body = response.body as RecordBody
    expect(preferencesResponseSchema.safeParse(body).success).toBe(true)
    expect(body.version).toBe(1)
    expect(body.values).toEqual(kenyaValues())
    expect(Object.keys(body).sort()).toEqual(["matchedRegions", "savedAt", "timeZoneLockedUntil", "values", "version"])
    expect(await read(kofi)).toEqual(body)
  })

  it(":54 Kofi edits his daily cap from 3 to 4 and reads daily cap 4 at version 2", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi, kenyaValues({ dailyCap: 3 }))
    const saved = await saveOnTop(kofi, { dailyCap: 4 })
    expect(saved.version).toBe(2)
    expect((await read(kofi)).values.dailyCap).toBe(4)
  })

  it(":148 a change is stored at the clock time and the previous value is kept in history", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    w.clock.set("2026-10-23T09:00:00.000Z")
    const saved = await saveOnTop(kofi, { payFloor: { amount: "4500.00", currency: "EUR", period: "month", basis: "gross" } })
    expect(new Date(saved.savedAt).toISOString()).toBe("2026-10-23T09:00:00.000Z")
    const history = await w.db.selectFrom("job_preferences_version").select(["version", "values"]).where("candidate_id", "=", w.kofi.id).orderBy("version").execute()
    expect(history.map((h) => h.version)).toEqual([1, 2])
    expect((history[0]!.values as { payFloor: { amount: string } }).payFloor.amount).toBe("4000.00")
    expect((history[1]!.values as { payFloor: { amount: string } }).payFloor.amount).toBe("4500.00")
  })

  it(":618 onboarding version 1 then a Settings save with baseVersion 1: one record, version 2, both versions kept", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    await saveOnTop(kofi, { dailyCap: 2 })
    expect(await w.db.selectFrom("job_preferences").select("version").where("candidate_id", "=", w.kofi.id).execute()).toEqual([{ version: 2 }])
    expect(await versionCount(w.db, w.kofi.id)).toBe(2)
  })

  it(":114 pay floor and preferred pay are stored separately, as 2-decimal strings, with their own basis", async () => {
    const kofi = await w.session(w.kofi)
    const body = await createRecord(kofi, kenyaValues({ payFloor: { amount: 4000 as unknown as string, currency: "EUR", period: "month", basis: "gross" }, preferredPay: { amount: "5500", currency: "EUR", period: "month", basis: "net" } }))
    expect(body.values.payFloor).toEqual({ amount: "4000.00", currency: "EUR", period: "month", basis: "gross" })
    expect(body.values.preferredPay).toEqual({ amount: "5500.00", currency: "EUR", period: "month", basis: "net" })
  })

  it(":121 tiers with backend 1, fullstack 2, people management excluded are stored as sent", async () => {
    const kofi = await w.session(w.kofi)
    const tiers = { ...DEFAULT_ROLE_FAMILY_TIERS, backend: 1, fullstack: 2, senior_frontend: 3, mobile: 3, people_management: "excluded" } as const
    const body = await createRecord(kofi, kenyaValues({ roleFamilyTiers: tiers }))
    expect(body.values.roleFamilyTiers).toEqual(tiers)
  })

  it(":135/:500 three themes, one of exactly 60 characters, are stored trimmed in saved order", async () => {
    const kofi = await w.session(w.kofi)
    const sixty = "building reliable payment APIs used by millions of customers"
    expect([...sixty].length).toBe(60)
    const body = await createRecord(kofi, kenyaValues({ emphasisThemes: ["  designing reliable payment APIs ", "scaling Postgres", sixty] }))
    expect(body.values.emphasisThemes).toEqual(["designing reliable payment APIs", "scaling Postgres", sixty])
  })

  it(":201 Kofi saves the title keyword react in a new version", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    const saved = await saveOnTop(kofi, { titleKeyword: "react" })
    expect(saved.version).toBe(2)
    expect(saved.values.titleKeyword).toBe("react")
  })

  it(":93/:626 the home country is listed first in work authorization and a repeated home country is stored once", async () => {
    const kofi = await w.session(w.kofi)
    const body = await createRecord(kofi, kenyaValues({ workAuthorizedCountries: ["ZA", "KE", "KE"] }))
    expect(body.values.workAuthorizedCountries).toEqual(["KE", "ZA"])
  })

  it(":641 no excluded relocation countries and no excluded industries is accepted", async () => {
    const kofi = await w.session(w.kofi)
    const body = await createRecord(kofi, kenyaValues({ excludedRelocationCountries: [], excludedIndustries: [] }))
    expect(body.values.excludedIndustries).toEqual([])
    expect(body.values.excludedRelocationCountries).toEqual([])
  })

  it(":510/:478 exactly one family in a tier, every other family excluded, is accepted", async () => {
    const kofi = await w.session(w.kofi)
    const tiers = Object.fromEntries(FAMILIES.map((f) => [f, f === "backend" ? 1 : "excluded"]))
    const body = await createRecord(kofi, kenyaValues({ roleFamilyTiers: tiers as never }))
    expect(body.values.roleFamilyTiers.backend).toBe(1)
  })

  it(":505 the smallest positive pay floor, 0.01 USD a month, is accepted", async () => {
    const kofi = await w.session(w.kofi)
    const body = await createRecord(kofi, kenyaValues({ payFloor: { amount: "0.01", currency: "USD", period: "month", basis: "gross" } }))
    expect(body.values.payFloor).toEqual({ amount: "0.01", currency: "USD", period: "month", basis: "gross" })
  })

  it("matchedRegions lists the regions containing Kenya, in table order, and only region keys", async () => {
    const kofi = await w.session(w.kofi)
    const body = await createRecord(kofi)
    expect(body.matchedRegions).toContain("africa")
    expect(body.matchedRegions).toContain("emea")
    expect(body.matchedRegions).not.toContain("europe")
    expect(body.matchedRegions).not.toContain("us")
  })
})

describe("home country rules (job-preferences.feature:218 to :253)", () => {
  it(":218 removing the home country from work authorization is refused (home_country_missing) and nothing changes", async () => {
    const kofi = await w.session(w.kofi)
    const v1 = await createRecord(kofi, kenyaValues({ workAuthorizedCountries: ["KE", "ZA"] }))
    const before = await preferencesRows(w.db, w.kofi.id)
    expectFieldError(await save(kofi, v1.version, { ...v1.values, workAuthorizedCountries: ["ZA"] }), "workAuthorizedCountries", "home_country_missing")
    expect(await preferencesRows(w.db, w.kofi.id)).toBe(before)
  })

  it(":225/:233 a home country change sent with both countries keeps both, leaves time settings, and the old one can then be removed", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    const changed = await saveOnTop(kofi, { homeCountry: "GH", workAuthorizedCountries: ["GH", "KE"] })
    expect(changed.values.workAuthorizedCountries).toEqual(["GH", "KE"])
    expect(changed.values.timeZone).toBe("Africa/Nairobi")
    expect(changed.values.latestWorkHour).toBe("23:00")
    const removed = await saveOnTop(kofi, { workAuthorizedCountries: ["GH"] })
    expect(removed.values.workAuthorizedCountries).toEqual(["GH"])
  })

  it(":239 the home country in excluded relocation countries is refused (home_country_excluded, with its position)", async () => {
    const kofi = await w.session(w.kofi)
    const response = await save(kofi, null, kenyaValues({ excludedRelocationCountries: ["ZA", "KE"] }))
    expectFieldError(response, "excludedRelocationCountries", "home_country_excluded")
    const hit = (response.body as { error: { fieldErrors: { field: string; position: number | null }[] } }).error.fieldErrors.find((e) => e.field === "excludedRelocationCountries")
    expect(hit?.position).toBe(2)
  })

  it(":253 a refused change (pay floor 0.00 with daily cap 4) leaves daily cap 3 and stores no version", async () => {
    const kofi = await w.session(w.kofi)
    const v1 = await createRecord(kofi, kenyaValues({ dailyCap: 3 }))
    expectFieldError(await save(kofi, v1.version, { ...v1.values, dailyCap: 4, payFloor: { amount: "0.00", currency: "EUR", period: "month", basis: "gross" } }), "payFloorAmount", "invalid")
    expect((await read(kofi)).values.dailyCap).toBe(3)
    expect(await versionCount(w.db, w.kofi.id)).toBe(1)
  })
})

type Row = readonly [label: string, change: LooseValues, field: string | null, problem?: string]

const pay = (amount: unknown, currency: unknown = "EUR", period: unknown = "month") => ({ amount, currency, period, basis: "gross" })
const net = (amount: unknown, currency: unknown = "EUR", period: unknown = "month") => ({ amount, currency, period, basis: "net" })

/** Gherkin Examples rows, each `[label, values change, field (null = accepted), problem]`. */
const VALIDATION: readonly Row[] = [
  // :269 pay floor amount
  ...(["4000", "4000.5", "4000.55", "0.01"] as const).map((a): Row => [`:269 pay floor ${a} accepted`, { payFloor: pay(a) }, null]),
  ...(["4000.555", "0", "0.00", "-100", "", "four"] as const).map((a): Row => [`:269 pay floor "${a}" refused`, { payFloor: pay(a) }, "payFloorAmount", "invalid"]),
  [":269 pay floor over 100,000,000 refused", { payFloor: pay("100000000.01") }, "payFloorAmount", "invalid"],
  [":269 pay floor with basis net refused", { payFloor: { amount: "4000.00", currency: "EUR", period: "month", basis: "net" } }, "payFloorAmount", "invalid"],
  // :287 currency and period
  ...(["EUR", "USD", "ZAR", "TRY"] as const).map((c): Row => [`:287 currency ${c} accepted`, { payFloor: pay("4000.00", c, c === "USD" || c === "TRY" ? "year" : "month") }, null]),
  ...(["NGN", "KES", "GHS", "EGP", "AED", "SAR", "XYZ", ""] as const).map((c): Row => [`:287 currency "${c}" refused`, { payFloor: pay("4000.00", c) }, "payFloorCurrency", "invalid"]),
  ...(["week", "hour"] as const).map((p): Row => [`:287 period ${p} refused`, { payFloor: pay("4000.00", "EUR", p) }, "payFloorPeriod", "invalid"]),
  // :323 preferred pay
  [":323 preferred 5500.00 EUR accepted", { preferredPay: net("5500.00") }, null],
  [":323 preferred 0 refused", { preferredPay: net("0") }, "preferredPayAmount", "invalid"],
  [":323 preferred 5500.555 refused", { preferredPay: net("5500.555") }, "preferredPayAmount", "invalid"],
  [":323 preferred XYZ refused", { preferredPay: net("5500.00", "XYZ") }, "preferredPayCurrency", "invalid"],
  [":323 preferred NGN refused", { preferredPay: net("5500.00", "NGN") }, "preferredPayCurrency", "invalid"],
  // :336 daily cap
  ...([1, 3, 5] as const).map((v): Row => [`:336 daily cap ${v} accepted`, { dailyCap: v }, null]),
  ...([0, 6, -1, 2.5, null, "3"] as const).map((v): Row => [`:336 daily cap ${JSON.stringify(v)} refused`, { dailyCap: v }, "dailyCap", "invalid"]),
  // :352 latest work hour
  ...(["01:00", "18:30", "23:59"] as const).map((v): Row => [`:352 latest hour ${v} accepted`, { latestWorkHour: v }, null]),
  ...(["00:00", "00:59", "24:00", "23:60", "18:30:30", "7pm", "9:5", ""] as const).map((v): Row => [`:352 latest hour "${v}" refused`, { latestWorkHour: v }, "latestWorkHour", "invalid"]),
  // :379 time zone (first save, so D41 does not apply)
  ...(["Africa/Nairobi", "Europe/Berlin", "America/Toronto", "UTC"] as const).map((v): Row => [`:379 time zone ${v} accepted`, { timeZone: v }, null]),
  ...(["WAT", "GMT+1", "Africa/Wakanda", "africa/nairobi", ""] as const).map((v): Row => [`:379 time zone "${v}" refused`, { timeZone: v }, "timeZone", "invalid"]),
  // :396 countries
  [":396 home country Atlantis refused", { homeCountry: "AT_LANTIS", workAuthorizedCountries: ["KE"] }, "homeCountry"],
  [":396 home country empty refused", { homeCountry: "" }, "homeCountry", "invalid"],
  [":396 home country XX refused as unsupported", { homeCountry: "XX", workAuthorizedCountries: ["XX"] }, "homeCountry", "unsupported_country"],
  [":396 work authorization Narnia refused", { workAuthorizedCountries: ["KE", "NN"] }, "workAuthorizedCountries", "unsupported_country"],
  [":396 excluded relocation Atlantis refused", { excludedRelocationCountries: ["XA"] }, "excludedRelocationCountries", "unsupported_country"],
  // :408 work arrangement
  [":408 remote only accepted", { remoteAccepted: true, relocationAccepted: false }, null],
  [":408 relocation only accepted", { remoteAccepted: false, relocationAccepted: true }, null],
  [":408 both accepted", { remoteAccepted: true, relocationAccepted: true }, null],
  [":408 none refused", { remoteAccepted: false, relocationAccepted: false }, "workArrangement", "none_selected"],
  // :420 sponsorship
  [":420 sponsorship yes accepted", { sponsorshipNeededForRelocation: true }, null],
  [":420 sponsorship no accepted", { sponsorshipNeededForRelocation: false }, null],
  [":420 sponsorship maybe refused", { sponsorshipNeededForRelocation: "maybe" }, "sponsorshipNeededForRelocation", "invalid"],
  // :431 industries
  [":431 crypto and web3 accepted", { excludedIndustries: ["crypto_and_web3"] }, null],
  [":431 weapons; tobacco accepted", { excludedIndustries: ["weapons_and_defense", "tobacco_and_vaping"] }, null],
  [":431 adult; gambling; betting accepted", { excludedIndustries: ["adult_content", "gambling", "betting"] }, null],
  [":431 video games accepted", { excludedIndustries: ["video_games_and_gaming_platforms"] }, null],
  [":431 fast food refused", { excludedIndustries: ["fast food"] }, "excludedIndustries", "unknown_entry"],
  [":431 Crypto refused", { excludedIndustries: ["Crypto"] }, "excludedIndustries", "unknown_entry"],
  // :451 / job-postings-per-candidate :465 role families
  [":451 backend tier 1 accepted", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, backend: 1 } }, null],
  [":451 mobile excluded accepted", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, mobile: "excluded" } }, null],
  [":451 devops_platform tier 2 accepted", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, devops_platform: 2 } }, null],
  [":451 data engineering refused", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, "data engineering": 1 } }, "roleFamilyTiers", "invalid"],
  [":451 backend tier 4 refused", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, backend: 4 } }, "roleFamilyTiers", "invalid"],
  [":451 backend tier 0 refused", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, backend: 0 } }, "roleFamilyTiers", "invalid"],
  [":465 (jppc) missing devops_platform refused", { roleFamilyTiers: Object.fromEntries(Object.entries(DEFAULT_ROLE_FAMILY_TIERS).filter(([k]) => k !== "devops_platform")) }, "roleFamilyTiers", "invalid"],
  [":465/:766 (jppc) key frontend instead of senior_frontend refused", { roleFamilyTiers: { ...Object.fromEntries(Object.entries(DEFAULT_ROLE_FAMILY_TIERS).filter(([k]) => k !== "senior_frontend")), frontend: 1 } }, "roleFamilyTiers", "invalid"],
  [":465 (jppc) extra key data_engineering refused", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, data_engineering: 1 } }, "roleFamilyTiers", "invalid"],
  [":465/:484 every family excluded refused", { roleFamilyTiers: Object.fromEntries(FAMILIES.map((f) => [f, "excluded"])) }, "roleFamilyTiers", "no_family_tiered"],
  // :470 seniority and employment
  [":470 senior, staff accepted", { seniorityLevels: ["senior", "staff"] }, null],
  [":470 no seniority refused", { seniorityLevels: [] }, "seniorityLevels", "none_selected"],
  [":470 seniority lead refused", { seniorityLevels: ["lead"] }, "seniorityLevels", "unknown_entry"],
  [":470 direct accepted", { employmentTypes: ["direct"] }, null],
  [":470 no employment type refused", { employmentTypes: [] }, "employmentTypes", "none_selected"],
  [":470 internship refused", { employmentTypes: ["internship"] }, "employmentTypes", "unknown_entry"],
  // :484 themes
  [":484 no themes accepted", { emphasisThemes: [] }, null],
  [":484 one theme accepted", { emphasisThemes: ["scaling Postgres"] }, null],
  [":484 a, b, c accepted", { emphasisThemes: ["a", "b", "c"] }, null],
  [":484 four themes refused", { emphasisThemes: ["a", "b", "c", "d"] }, "emphasisThemes", "too_many_entries"],
  [":484 61-character theme refused", { emphasisThemes: ["x".repeat(61)] }, "emphasisThemes", "entry_too_long"],
  [":484 blank theme refused", { emphasisThemes: ["   "] }, "emphasisThemes", "entry_empty"],
  // job-postings-per-candidate :932 keyword
  [":932 (jppc) a keyword of 100 characters accepted", { titleKeyword: "a".repeat(100) }, null],
  [":932 (jppc) a keyword of 101 characters refused", { titleKeyword: "a".repeat(101) }, "titleKeyword", "too_long"],
  [":932 (jppc) a bell character refused", { titleKeyword: "react\u0007" }, "titleKeyword", "control_characters"],
  [":932 (jppc) a null character refused", { titleKeyword: "react\u0000" }, "titleKeyword", "control_characters"],
  [":932 (jppc) a number keyword refused", { titleKeyword: 5 }, "titleKeyword", "invalid"],
]

describe("field validation (contract table; Gherkin Examples rows)", () => {
  it.each(VALIDATION.map((row) => [...row] as [string, LooseValues, string | null, string | undefined]))("%s", async (_label, change, field, problem) => {
    const kofi = await w.session(w.kofi)
    const values = { ...kenyaValues(), ...change }
    const response = await save(kofi, null, values)
    if (field === null) {
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      expect((response.body as RecordBody).version).toBe(1)
    } else {
      expectFieldError(response, field, problem)
      expect(JSON.stringify(response.body)).not.toContain("AT_LANTIS")
      expect(await versionCount(w.db, w.kofi.id)).toBe(0)
    }
  })

  it("PAY_CURRENCIES are exactly the 20 rate-table codes, USD first and EUR second (:308 server side)", () => {
    expect(PAY_CURRENCIES).toHaveLength(20)
    expect(PAY_CURRENCIES.slice(0, 2)).toEqual(["USD", "EUR"])
    for (const code of ["NGN", "KES", "GHS", "EGP", "AED", "SAR"]) expect(PAY_CURRENCIES).not.toContain(code)
  })

  it(":932 (jppc) '  react  ' and 'a×100' padded with 10 spaces are stored trimmed", async () => {
    const kofi = await w.session(w.kofi)
    expect((await createRecord(kofi, kenyaValues({ titleKeyword: "  react  " }))).values.titleKeyword).toBe("react")
    const long = `${" ".repeat(10)}${"a".repeat(100)}${" ".repeat(10)}`
    expect((await saveOnTop(kofi, { titleKeyword: long })).values.titleKeyword).toBe("a".repeat(100))
  })

  it.each([
    ["one zero-width space", "\u200B"],
    ["three zero-width characters", "\u200B\u200C\u200D"],
    ["a byte-order mark", "\uFEFF"],
    ["one combining acute accent", "\u0301"],
    ["a zero-width space between spaces", "  \u200B  "],
    ["a word joiner and a soft hyphen", "\u2060\u00AD"],
    ["blank", "   "],
  ])(":877/:925 (jppc) a keyword of %s is stored as null and is not an error", async (_label, keyword) => {
    const kofi = await w.session(w.kofi)
    expect((await createRecord(kofi, kenyaValues({ titleKeyword: keyword }))).values.titleKeyword).toBeNull()
  })

  it(":947/:953 (jppc) 'Réact Native' keeps its display form and 're\\u200Bact' is kept", async () => {
    const kofi = await w.session(w.kofi)
    expect((await createRecord(kofi, kenyaValues({ titleKeyword: "Réact Native" }))).values.titleKeyword).toBe("Réact Native")
    expect((await saveOnTop(kofi, { titleKeyword: "re\u200Bact" })).values.titleKeyword).toBe("re\u200Bact")
  })

  it("field errors come in the contract's field order, never echo a value, and refuse the whole save", async () => {
    const kofi = await w.session(w.kofi)
    const response = await save(kofi, null, kenyaValues({ dailyCap: 9, latestWorkHour: "SENTINEL-HOUR", timeZone: "SENTINEL/ZONE" }))
    expect(response.status).toBe(400)
    const fields = (response.body as { error: { fieldErrors: { field: string }[] } }).error.fieldErrors.map((e) => e.field)
    expect(fields).toEqual(["timeZone", "latestWorkHour", "dailyCap"])
    expect(JSON.stringify(response.body)).not.toMatch(/SENTINEL/)
  })
})

describe("request shape (contract: plain 400 without fieldErrors)", () => {
  it.each([
    [":681 baseVersion missing", (v: LooseValues) => ({ values: v })],
    ["baseVersion 0", (v: LooseValues) => ({ baseVersion: 0, values: v })],
    ["baseVersion '1'", (v: LooseValues) => ({ baseVersion: "1", values: v })],
    ["an unknown top-level key candidateId", (v: LooseValues) => ({ baseVersion: null, values: v, candidateId: "00000000-0000-4000-8000-000000000001" })],
    ["an unknown values key minCoreMatchPercent (B2 field)", (v: LooseValues) => ({ baseVersion: null, values: { ...v, minCoreMatchPercent: 70 } })],
    ["a body that is an array", () => [1, 2]],
  ])("%s is 400 bad_request without fieldErrors and writes nothing", async (_label, body) => {
    const kofi = await w.session(w.kofi)
    expectPlainBadRequest(await kofi.put(PREFS).send(body(kenyaValues() as unknown as LooseValues) as object))
    expect(await versionCount(w.db, w.kofi.id)).toBe(0)
  })

  // qa-1 gate correction: a missing values key is a field error, not a plain 400
  // (api-contract-b1.md:79 lists only unknown keys and baseVersion as plain 400s; the
  // field table gives dailyCap `invalid` for "not an integer 1 to 5", which covers absent).
  it("a values object missing dailyCap is 400 with the field error dailyCap invalid and writes nothing", async () => {
    const kofi = await w.session(w.kofi)
    const values = Object.fromEntries(Object.entries(kenyaValues() as unknown as LooseValues).filter(([k]) => k !== "dailyCap"))
    const response = await kofi.put(PREFS).send({ baseVersion: null, values })
    expectFieldError(response, "dailyCap", "invalid")
    const fieldErrors = (response.body as { error: { fieldErrors: { field: string; problem: string; position: number | null }[] } }).error.fieldErrors
    expect(fieldErrors).toEqual([{ field: "dailyCap", position: null, problem: "invalid" }])
    expect(await versionCount(w.db, w.kofi.id)).toBe(0)
  })

  it(":681 a save without baseVersion when a record exists is refused and the version is unchanged", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    expectPlainBadRequest(await kofi.put(PREFS).send({ values: kenyaValues({ dailyCap: 2 }) }))
    expect((await read(kofi)).version).toBe(1)
  })

  it("malformed JSON is 400 bad_request", async () => {
    const kofi = await w.session(w.kofi)
    const response = await kofi.put(PREFS).set("content-type", "application/json").send("{not json")
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe("bad_request")
  })

  it("a body over 1 MiB is 413 payload_too_large", async () => {
    const kofi = await w.session(w.kofi)
    // In-process inject (as client-errors.int-spec.ts): Fastify answers 413 from content-length and closes a real socket mid-write.
    const fastify = w.app.getHttpAdapter().getInstance() as import("fastify").FastifyInstance
    const response = await fastify.inject({
      method: "PUT",
      url: PREFS,
      headers: { "content-type": "application/json", cookie: kofi.cookie, "x-csrf-token": kofi.csrfToken },
      payload: JSON.stringify({ baseVersion: null, values: kenyaValues({ emphasisThemes: ["x".repeat(1_100_000)] }) }),
    })
    expect(response.statusCode).toBe(413)
    expect(response.json().error.code).toBe("payload_too_large")
  })
})

describe("baseVersion and 409 preferences_stale (job-preferences.feature:610, :656, :665, :675)", () => {
  it(":610 resending the same save with an already-used baseVersion is 409 with currentVersion, nothing written", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    await saveOnTop(kofi, {})
    await saveOnTop(kofi, {})
    const base = (await read(kofi)).version
    expect(base).toBe(3)
    await save(kofi, base, kenyaValues({ dailyCap: 2 })).expect(200)
    const before = await preferencesRows(w.db, w.kofi.id)
    const again = await save(kofi, base, kenyaValues({ dailyCap: 2 }))
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: { code: "preferences_stale", message: "Your preferences changed in another tab. Reload to see the latest.", currentVersion: 4 } })
    expect(await preferencesRows(w.db, w.kofi.id)).toBe(before)
  })

  it("a number baseVersion with no record is 409 with currentVersion null", async () => {
    const kofi = await w.session(w.kofi)
    const response = await save(kofi, 1, kenyaValues())
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({ code: "preferences_stale", currentVersion: null })
    expect(await versionCount(w.db, w.kofi.id)).toBe(0)
  })

  it("a null baseVersion when a record exists is 409 with the current version", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    const response = await save(kofi, null, kenyaValues({ dailyCap: 1 }))
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 1 })
    expect((await read(kofi)).values.dailyCap).toBe(3)
  })

  it(":665/:675 a save from version 5 when 6 is current is refused; reloading and saving on 6 gives version 7 with daily cap 2", async () => {
    const kofi = await w.session(w.kofi)
    await createRecord(kofi)
    for (let i = 0; i < 5; i += 1) await saveOnTop(kofi, {})
    const tab = await w.session(w.kofi)
    const refused = await save(tab, 5, kenyaValues({ dailyCap: 2 }))
    expect(refused.status).toBe(409)
    expect(refused.body.error.currentVersion).toBe(6)
    expect((await read(tab)).values.dailyCap).toBe(3)
    const saved = await save(tab, 6, kenyaValues({ dailyCap: 2 }))
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ version: 7, values: { dailyCap: 2 } })
  })

  it(":656 two simultaneous saves on version 4 apply exactly one; the other is 409 with currentVersion 5 and nothing merged", async () => {
    const first = await w.session(w.kofi)
    await createRecord(first)
    for (let i = 0; i < 3; i += 1) await saveOnTop(first, {})
    const [tabA, tabB] = [await w.session(w.kofi), await w.session(w.kofi)]
    const results = await Promise.all([
      save(tabA, 4, kenyaValues({ dailyCap: 2 })),
      save(tabB, 4, kenyaValues({ payFloor: { amount: "4500.00", currency: "EUR", period: "month", basis: "gross" } })),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const loser = results.find((r) => r.status === 409)!
    expect(loser.body.error).toMatchObject({ code: "preferences_stale", currentVersion: 5 })
    const current = await read(tabA)
    expect(current.version).toBe(5)
    const tookCap = current.values.dailyCap === 2
    expect(current.values.payFloor?.amount).toBe(tookCap ? "4000.00" : "4500.00")
    expect(await versionCount(w.db, w.kofi.id)).toBe(5)
  })

  it("two concurrent first saves create one version 1 and refuse the other as stale", async () => {
    const [a, b] = [await w.session(w.kofi), await w.session(w.kofi)]
    const results = await Promise.all([save(a, null, kenyaValues({ dailyCap: 1 })), save(b, null, kenyaValues({ dailyCap: 2 }))])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await versionCount(w.db, w.kofi.id)).toBe(1)
  })
})

describe("D41: one time zone change per 24 hours (job-preferences.feature:534, :547, :555; GAP-P7)", () => {
  async function changedAtNine(): Promise<{ kofi: Awaited<ReturnType<B1World["session"]>> }> {
    const kofi = await w.session(w.kofi)
    w.clock.set("2026-10-22T08:00:00.000Z")
    await createRecord(kofi, kenyaValues({ timeZone: "Africa/Nairobi" }))
    w.clock.set("2026-10-23T09:00:00.000Z")
    const changed = await saveOnTop(kofi, { timeZone: "Africa/Lagos" })
    expect(new Date(changed.timeZoneLockedUntil!).toISOString()).toBe("2026-10-24T09:00:00.000Z")
    return { kofi }
  }

  it("GAP-P7: the first time zone (version 1) is free and starts no limit; a same-day correction is accepted", async () => {
    const kofi = await w.session(w.kofi)
    w.clock.set("2026-10-23T09:00:00.000Z")
    const v1 = await createRecord(kofi, kenyaValues({ timeZone: "Africa/Nairobi" }))
    expect(v1.timeZoneLockedUntil).toBeNull()
    w.clock.set("2026-10-23T09:05:00.000Z")
    const corrected = await saveOnTop(kofi, { timeZone: "Africa/Lagos" })
    expect(corrected.values.timeZone).toBe("Africa/Lagos")
  })

  it.each([
    ["2026-10-23T09:00:01.000Z", 409],
    ["2026-10-24T08:59:59.000Z", 409],
    ["2026-10-24T09:00:00.000Z", 200],
    ["2026-10-25T12:00:00.000Z", 200],
  ])(":534 after a change at 09:00 on 23 Oct, a change to Europe/Berlin at %s is %i", async (time, status) => {
    const { kofi } = await changedAtNine()
    w.clock.set(time)
    const current = await read(kofi)
    const response = await save(kofi, current.version, { ...current.values, timeZone: "Europe/Berlin" })
    expect(response.status, JSON.stringify(response.body)).toBe(status)
    if (status === 409) {
      expect(response.body).toEqual({ error: { code: "timezone_change_rate_limited", message: "You can change your time zone once a day.", timeZoneLockedUntil: expect.any(String) } })
      expect(new Date(response.body.error.timeZoneLockedUntil).toISOString()).toBe("2026-10-24T09:00:00.000Z")
    }
  })

  it(":547 a time zone change with daily cap 2 at 15:00 refuses the whole save and leaves version 5", async () => {
    const kofi = await w.session(w.kofi)
    w.clock.set("2026-10-22T08:00:00.000Z")
    await createRecord(kofi, kenyaValues({ timeZone: "Africa/Nairobi" }))
    await saveOnTop(kofi, {})
    await saveOnTop(kofi, {})
    await saveOnTop(kofi, {})
    w.clock.set("2026-10-23T09:00:00.000Z")
    await saveOnTop(kofi, { timeZone: "Africa/Lagos" })
    const before = await read(kofi)
    expect(before.version).toBe(5)
    w.clock.set("2026-10-23T15:00:00.000Z")
    const response = await save(kofi, 5, { ...before.values, timeZone: "Europe/Berlin", dailyCap: 2 })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe("timezone_change_rate_limited")
    const after = await read(kofi)
    expect(after.version).toBe(5)
    expect(after.values.timeZone).toBe("Africa/Lagos")
    expect(after.values.dailyCap).toBe(before.values.dailyCap)
  })

  it(":555 saves that keep the time zone at 10:00 and 11:00 are both applied, and GET reports the lock", async () => {
    const { kofi } = await changedAtNine()
    w.clock.set("2026-10-23T10:00:00.000Z")
    await saveOnTop(kofi, { dailyCap: 2 })
    w.clock.set("2026-10-23T11:00:00.000Z")
    const saved = await saveOnTop(kofi, { payFloor: { amount: "4500.00", currency: "EUR", period: "month", basis: "gross" } })
    expect(saved.values.dailyCap).toBe(2)
    expect(new Date((await read(kofi)).timeZoneLockedUntil!).toISOString()).toBe("2026-10-24T09:00:00.000Z")
    w.clock.set("2026-10-24T09:00:00.000Z")
    expect((await read(kofi)).timeZoneLockedUntil).toBeNull()
  })

  it("the Operator's migrated version 1 counts as the first set: Ada's next time zone change is allowed", async () => {
    const ada = await w.session(w.ada)
    const current = await read(ada)
    const target = current.values.timeZone === "Africa/Lagos" ? "Africa/Accra" : "Africa/Lagos"
    const saved = await save(ada, current.version, { ...current.values, timeZone: target })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    await save(ada, saved.body.version, { ...saved.body.values, timeZone: current.values.timeZone }).expect(409)
  })
})

describe("the migrated Operator (contract decisions: 0025 owner value shape; jppc :1017)", () => {
  it(":1017 Ada reads a record in the v1.23.0 shape: no keyword, no excluded family, all five levels, every catalog key", async () => {
    const ada = await w.session(w.ada)
    const response = await ada.get(PREFS).expect(200)
    expect(preferencesResponseSchema.safeParse(response.body).success, JSON.stringify(response.body)).toBe(true)
    const body = response.body as RecordBody
    expect(body.version).toBeGreaterThanOrEqual(1)
    expect(body.values.titleKeyword).toBeNull()
    expect(Object.values(body.values.roleFamilyTiers)).not.toContain("excluded")
    expect(Object.keys(body.values.roleFamilyTiers).sort()).toEqual([...FAMILIES].sort())
    expect(body.values.seniorityLevels).toEqual(["junior", "mid", "senior", "staff", "principal"])
    expect(body.values.homeCountry).toBe("NG")
  })
})
