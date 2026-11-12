import { SUPPORTED_COUNTRIES, type RegionKey } from "@eve/contracts"

import type { CountryCode, PayCurrency } from "@/entities/job-preferences"

/**
 * Country and currency names are pinned in copy-deck.r6 ("Names in the Job Preferences
 * form", B1-CW-1): fixed strings, never `Intl.DisplayNames`, whose output changes with the
 * browser's CLDR data (CLDR 48 says "Türkiye"; the api and Gherkin say "Turkey").
 */
export const COUNTRY_NAME: Record<CountryCode, string> = {
  AE: "United Arab Emirates", CA: "Canada", CH: "Switzerland", DE: "Germany",
  DK: "Denmark", EG: "Egypt", ES: "Spain", FR: "France",
  GB: "United Kingdom", GH: "Ghana", IE: "Ireland", JO: "Jordan",
  KE: "Kenya", LB: "Lebanon", NG: "Nigeria", NL: "Netherlands",
  NO: "Norway", OM: "Oman", PL: "Poland", PT: "Portugal",
  QA: "Qatar", SA: "Saudi Arabia", SE: "Sweden", SG: "Singapore",
  TH: "Thailand", TR: "Turkey", US: "United States", ZA: "South Africa",
}

export const CURRENCY_NAME: Record<PayCurrency, string> = {
  USD: "US Dollar", EUR: "Euro", AUD: "Australian Dollar", BRL: "Brazilian Real",
  CAD: "Canadian Dollar", CHF: "Swiss Franc", CZK: "Czech Koruna", DKK: "Danish Krone",
  GBP: "British Pound", ILS: "Israeli New Shekel", INR: "Indian Rupee", JPY: "Japanese Yen",
  MXN: "Mexican Peso", NOK: "Norwegian Krone", NZD: "New Zealand Dollar", PLN: "Polish Zloty",
  SEK: "Swedish Krona", SGD: "Singapore Dollar", TRY: "Turkish Lira", ZAR: "South African Rand",
}

export const countryName = (code: CountryCode): string => COUNTRY_NAME[code]

/** The 28 supported countries, by English name. */
export const COUNTRY_OPTIONS: readonly CountryCode[] = (Object.keys(SUPPORTED_COUNTRIES) as CountryCode[]).sort((a, b) =>
  countryName(a).localeCompare(countryName(b), "en")
)

/** "EUR, Euro" (F4 step 10). */
export const currencyOption = (code: PayCurrency): string => `${code}, ${CURRENCY_NAME[code]}`

/** `prefs.region.{key}` (copy-deck.r6), joined into `C-PREF-REGIONS` in the API's order. */
export const REGION_LABEL: Record<RegionKey, string> = {
  africa: "Africa",
  emea: "EMEA",
  europe: "Europe",
  eu: "EU",
  middle_east: "Middle East",
  north_america: "North America",
  americas: "Americas",
  latam: "LATAM",
  apac: "APAC",
  asia: "Asia",
  uk: "UK",
  us: "US",
}

/** IANA zones the browser knows, plus UTC and any saved zone it doesn't list (the server is authoritative). */
export function timeZoneOptions(current: string): readonly string[] {
  const zones = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])
  if (current !== "") zones.add(current)
  return [...zones].sort()
}

/**
 * Zone abbreviations Intl's English data spells as offsets ("GMT+1"). The spec wireframe
 * writes "WAT" (design-spec.r6:134). Every other zone uses Intl's short name.
 */
const ZONE_ABBR: Readonly<Record<string, string>> = {
  "Africa/Lagos": "WAT",
  "Africa/Nairobi": "EAT",
  "Africa/Johannesburg": "SAST",
  "Africa/Cairo": "EET",
}

const validZone = (timeZone: string): string => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone })
    return timeZone
  } catch {
    return "UTC"
  }
}

/**
 * `{date time}` for `prefs.save.applies`, in the Candidate's saved time zone, with the
 * zone so it can't be read as browser time (DP-B1-08): "28 Oct 2026, 13:00 WAT".
 */
export function formatSavedAt(iso: string, timeZone: string): string {
  const date = new Date(iso)
  const zone = validZone(timeZone)
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", year: "numeric" }).format(date).replace(/\bSept\b/, "Sep")
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
  const abbr =
    ZONE_ABBR[zone] ??
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ??
    zone
  return `${day}, ${time} ${abbr}`
}
