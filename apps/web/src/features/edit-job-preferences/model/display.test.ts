import { PAY_CURRENCIES, SUPPORTED_COUNTRIES } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { COUNTRY_NAME, COUNTRY_OPTIONS, countryName, CURRENCY_NAME, currencyOption, REGION_LABEL } from "./display"

/** copy-deck.r6 "Names in the Job Preferences form" (B1-CW-1): pinned, never read from Intl at run time. */
describe("pinned names", () => {
  it("has a name for exactly the 28 supported countries, TR as Turkey", () => {
    expect(Object.keys(COUNTRY_NAME).sort()).toEqual(Object.keys(SUPPORTED_COUNTRIES).sort())
    expect(countryName("TR")).toBe("Turkey")
    expect(countryName("GB")).toBe("United Kingdom")
    expect(countryName("AE")).toBe("United Arab Emirates")
  })

  it("sorts country options by English name", () => {
    expect(COUNTRY_OPTIONS.slice(0, 3).map(countryName)).toEqual(["Canada", "Denmark", "Egypt"])
    expect(COUNTRY_OPTIONS.at(-1)).toBe("US")
  })

  it("has a name for exactly the 20 pay currencies and renders {code}, {name}", () => {
    expect(Object.keys(CURRENCY_NAME).sort()).toEqual([...PAY_CURRENCIES].sort())
    expect(currencyOption("EUR")).toBe("EUR, Euro")
    expect(currencyOption("ILS")).toBe("ILS, Israeli New Shekel")
    expect(currencyOption("PLN")).toBe("PLN, Polish Zloty")
  })

  it("labels the 12 region keys", () => {
    expect(Object.values(REGION_LABEL)).toEqual(["Africa", "EMEA", "Europe", "EU", "Middle East", "North America", "Americas", "LATAM", "APAC", "Asia", "UK", "US"])
  })
})

describe("formatSavedAt (DP-B1-08)", () => {
  it("shows the saved zone's time with its abbreviation", async () => {
    const { formatSavedAt } = await import("./display")
    expect(formatSavedAt("2026-10-28T12:00:00.000Z", "Africa/Lagos")).toBe("28 Oct 2026, 13:00 WAT")
    expect(formatSavedAt("2026-10-28T12:00:00.000Z", "Africa/Nairobi")).toBe("28 Oct 2026, 15:00 EAT")
    expect(formatSavedAt("2026-10-28T12:00:00.000Z", "Europe/Berlin")).toBe("28 Oct 2026, 13:00 CET")
  })
})
