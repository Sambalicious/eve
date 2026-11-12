import { parsePreferencesRequest, STEP3_DEFAULTS } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { savedPreferences } from "@/shared/testing/preferences-api"
import {
  changeHomeCountry,
  fieldErrorsFromServer,
  isDirty,
  toFormState,
  toSaveInput,
  validate,
  type FormState,
} from "./preferences-form"

const kofi = () => toFormState(savedPreferences())

describe("toFormState / toSaveInput", () => {
  it("round-trips a saved record into a body the contract parser accepts unchanged", () => {
    const values = savedPreferences({ titleKeyword: "react", emphasisThemes: ["scaling Postgres"] })
    const input = toSaveInput(toFormState(values), 3)
    const parsed = parsePreferencesRequest(input)
    expect(parsed).toEqual({ ok: true, baseVersion: 3, values })
  })

  it("starts from the server's defaults with blank pay and no home country", () => {
    const state = toFormState(STEP3_DEFAULTS)
    expect(state.homeCountry).toBeNull()
    expect(state.payFloor).toEqual({ amount: "", currency: "", period: "month" })
    expect(state.dailyCap).toBe(5)
    expect(state.themes).toEqual(["", "", ""])
  })

  it("sends a blank keyword as null and drops blank theme slots", () => {
    const state: FormState = { ...kofi(), titleKeyword: "   ", themes: ["a", "", " b "] }
    const input = toSaveInput(state, 1)
    expect(input.values.titleKeyword).toBeNull()
    expect(input.values.emphasisThemes).toEqual(["a", " b "])
  })
})

describe("validate (client, same rules as the server)", () => {
  it.each([
    ["4000", true],
    ["4000.55", true],
    ["0.01", true],
    ["4000.555", false],
    ["0", false],
    ["-100", false],
    ["", false],
    ["four", false],
  ])("pay floor amount %s valid=%s", (amount, ok) => {
    const errors = validate({ ...kofi(), payFloor: { amount, currency: "EUR", period: "month" } })
    expect(errors.has("payFloorAmount")).toBe(!ok)
  })

  it.each(["01:00", "18:30", "23:59"])("accepts latest work hour %s", (hour) => {
    expect(validate({ ...kofi(), latestWorkHour: hour }).has("latestWorkHour")).toBe(false)
  })

  it.each(["00:00", "00:59", "24:00", "23:60", "18:30:30", "7pm", "9:5", ""])("refuses latest work hour %s", (hour) => {
    expect(validate({ ...kofi(), latestWorkHour: hour }).get("latestWorkHour")).toBe("Choose a time from 01:00 to 23:59.")
  })

  it("refuses a missing home country, currency, and every family excluded", () => {
    const tiers = Object.fromEntries(Object.keys(STEP3_DEFAULTS.roleFamilyTiers).map((k) => [k, "excluded"])) as FormState["tiers"]
    const errors = validate({ ...toFormState(STEP3_DEFAULTS), tiers, payFloor: { amount: "10", currency: "", period: "month" } })
    expect(errors.get("homeCountry")).toBe("Choose your home country.")
    expect(errors.get("payFloorCurrency")).toBe("Choose a currency.")
    expect(errors.get("roleFamilyTiers")).toBe("Put at least one role family in a tier.")
    expect([...errors.keys()][0]).toBe("homeCountry")
  })

  it("refuses an empty seniority or employment list, a long or controlled keyword and a 61-character theme", () => {
    const errors = validate({ ...kofi(), seniority: [], employment: [], titleKeyword: `  ${"a".repeat(101)}  `, themes: ["x".repeat(61), "", ""] })
    expect(errors.get("seniorityLevels")).toBe("Choose at least one seniority level.")
    expect(errors.get("employmentTypes")).toBe("Choose at least one employment type.")
    expect(errors.get("titleKeyword")).toBe("Keep the keyword to 100 characters.")
    expect(errors.get("emphasisThemes")).toBe("Keep each theme to 60 characters.")
    expect(validate({ ...kofi(), titleKeyword: "re\u0000act" }).get("titleKeyword")).toBe("Remove hidden control characters from the keyword.")
  })

  it("accepts exactly 100 characters after trimming and a zero-width-only keyword", () => {
    expect(validate({ ...kofi(), titleKeyword: ` ${"a".repeat(100)} ` }).has("titleKeyword")).toBe(false)
    expect(validate({ ...kofi(), titleKeyword: "\u200b\u200b" }).has("titleKeyword")).toBe(false)
  })
})

describe("fieldErrorsFromServer", () => {
  it("maps contract field errors to the field's own message, in field order", () => {
    const errors = fieldErrorsFromServer([
      { field: "latestWorkHour", position: null, problem: "invalid" },
      { field: "excludedRelocationCountries", position: 1, problem: "home_country_excluded" },
      { field: "titleKeyword", position: null, problem: "too_long" },
    ])
    expect([...errors.entries()]).toEqual([
      ["latestWorkHour", "Choose a time from 01:00 to 23:59."],
      ["excludedRelocationCountries", "Your home country can't be excluded."],
      ["titleKeyword", "Keep the keyword to 100 characters."],
    ])
  })
})

describe("changeHomeCountry (F4 step 8)", () => {
  it("adds the new home first, keeps the old one, leaves time settings alone", () => {
    const next = changeHomeCountry(kofi(), "GH")
    expect(next.state.workAuthorizedCountries).toEqual(["GH", "KE"])
    expect(next.state.timeZone).toBe("Africa/Nairobi")
    expect(next.notice).toEqual({ next: "GH", old: "KE", unexcluded: false })
  })

  it("removes the new home from excluded relocation countries", () => {
    const next = changeHomeCountry({ ...kofi(), excludedCountries: ["ZA", "EG"] }, "ZA")
    expect(next.state.excludedCountries).toEqual(["EG"])
    expect(next.notice?.unexcluded).toBe(true)
  })

  it("defaults the time zone from the first home country chosen", () => {
    const next = changeHomeCountry(toFormState(STEP3_DEFAULTS), "NG")
    expect(next.state.timeZone).toBe("Africa/Lagos")
    expect(next.state.workAuthorizedCountries).toEqual(["NG"])
    expect(next.notice).toBeNull()
  })
})

describe("isDirty", () => {
  it("is false for the loaded values and true after any edit", () => {
    const base = kofi()
    expect(isDirty(base, kofi())).toBe(false)
    expect(isDirty({ ...base, dailyCap: 4 }, base)).toBe(true)
  })
})
