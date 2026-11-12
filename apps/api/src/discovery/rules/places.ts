import type { RegionKey } from "@eve/contracts"

/**
 * EPIC-0002 B1: the place and region catalog the location rules read
 * (PRD r4 AC 5.2 to 5.5, E1). Catalog data, not Candidate values: rule code
 * names no Candidate's country, so the same code reads every Candidate's home
 * country, work-authorized countries and excluded relocation countries.
 *
 * Each country has its ISO 3166-1 alpha-2 code, a display name (stored as the
 * relocation country, so it stays the name EPIC-0001 stored) and the folded
 * names and large cities a posting may use. The first name of every country
 * in today's relocation list keeps its EPIC-0001 order, so the Operator's
 * stored destinations are unchanged.
 */
export type Place = Readonly<{ code: string; name: string; names: readonly string[] }>

export const PLACES: readonly Place[] = [
  { code: "OM", name: "Oman", names: ["oman", "muscat"] },
  { code: "TR", name: "Turkey", names: ["turkey", "turkiye", "istanbul", "ankara", "izmir"] },
  { code: "JO", name: "Jordan", names: ["jordan", "amman"] },
  { code: "LB", name: "Lebanon", names: ["lebanon", "beirut"] },
  { code: "TH", name: "Thailand", names: ["thailand", "bangkok", "chiang mai", "phuket"] },
  { code: "DE", name: "Germany", names: ["germany", "berlin", "munich", "hamburg", "frankfurt", "cologne"] },
  { code: "NL", name: "Netherlands", names: ["netherlands", "the netherlands", "holland", "amsterdam", "rotterdam", "utrecht", "the hague"] },
  { code: "AE", name: "United Arab Emirates", names: ["united arab emirates", "uae", "dubai", "abu dhabi"] },
  { code: "CA", name: "Canada", names: ["canada", "toronto", "vancouver", "montreal", "ottawa", "calgary"] },
  { code: "GB", name: "United Kingdom", names: ["united kingdom", "uk", "england", "london", "manchester", "edinburgh"] },
  { code: "US", name: "United States", names: ["united states", "usa", "new york", "san francisco", "seattle", "austin", "boston"] },
  { code: "IE", name: "Ireland", names: ["ireland", "dublin"] },
  { code: "PT", name: "Portugal", names: ["portugal", "lisbon", "porto"] },
  { code: "ES", name: "Spain", names: ["spain", "madrid", "barcelona", "valencia"] },
  { code: "FR", name: "France", names: ["france", "paris", "lyon"] },
  { code: "PL", name: "Poland", names: ["poland", "warsaw", "krakow"] },
  { code: "SE", name: "Sweden", names: ["sweden", "stockholm"] },
  { code: "DK", name: "Denmark", names: ["denmark", "copenhagen"] },
  { code: "NO", name: "Norway", names: ["norway", "oslo"] },
  { code: "CH", name: "Switzerland", names: ["switzerland", "zurich", "geneva"] },
  { code: "SG", name: "Singapore", names: ["singapore"] },
  { code: "SA", name: "Saudi Arabia", names: ["saudi arabia", "riyadh", "jeddah"] },
  { code: "QA", name: "Qatar", names: ["qatar", "doha"] },
  // B1: the rest of the supported home countries (SUPPORTED_COUNTRIES), after the EPIC-0001 list.
  { code: "NG", name: "Nigeria", names: ["nigeria", "nigerian", "lagos", "abuja"] },
  { code: "GH", name: "Ghana", names: ["ghana", "ghanaian", "accra", "kumasi"] },
  { code: "KE", name: "Kenya", names: ["kenya", "kenyan", "nairobi", "mombasa"] },
  { code: "ZA", name: "South Africa", names: ["south africa", "johannesburg", "cape town", "durban", "pretoria"] },
  { code: "EG", name: "Egypt", names: ["egypt", "egyptian", "cairo", "alexandria"] },
]

/** Countries a posting may name that are not supported home countries; for reading a restriction only. */
const OTHER_COUNTRIES: readonly Place[] = [
  { code: "IN", name: "India", names: ["india", "bangalore", "bengaluru", "mumbai"] },
  { code: "AU", name: "Australia", names: ["australia", "sydney", "melbourne"] },
  { code: "NZ", name: "New Zealand", names: ["new zealand", "auckland"] },
  { code: "BR", name: "Brazil", names: ["brazil", "sao paulo"] },
  { code: "MX", name: "Mexico", names: ["mexico", "mexico city"] },
  { code: "PH", name: "Philippines", names: ["philippines", "manila"] },
  { code: "UG", name: "Uganda", names: ["uganda", "kampala"] },
  { code: "RW", name: "Rwanda", names: ["rwanda", "kigali"] },
  { code: "IL", name: "Israel", names: ["israel", "tel aviv"] },
]

const ALL_PLACES: readonly Place[] = [...PLACES, ...OTHER_COUNTRIES]

/** Folded names of a country (from either list), or [] for a code the catalog does not hold. */
export function namesOf(code: string): readonly string[] {
  return ALL_PLACES.find((place) => place.code === code)?.names ?? []
}

const AU_MEMBERS = [
  "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG", "CD", "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH",
  "GN", "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ", "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA",
  "SS", "SD", "TZ", "TG", "TN", "UG", "ZM", "ZW", "EH",
]
const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]
const EUROPE = [...EU, "GB", "NO", "CH", "IS", "LI", "UA", "RS", "BA", "ME", "MK", "AL", "MD", "XK", "TR"]
const MIDDLE_EAST = ["AE", "SA", "QA", "BH", "KW", "OM", "JO", "LB", "IL", "IQ", "IR", "SY", "YE", "PS", "EG", "TR"]
const LATAM = [
  "MX", "BZ", "CR", "SV", "GT", "HN", "NI", "PA", "AG", "BS", "BB", "CU", "DM", "DO", "GD", "HT", "JM", "KN", "LC", "VC", "TT",
  "AR", "BO", "BR", "CL", "CO", "EC", "GY", "PY", "PE", "SR", "UY", "VE",
]
const ASIA = [
  "AF", "PK", "IN", "NP", "BT", "BD", "LK", "MV", "CN", "MN", "KP", "KR", "JP", "TW", "HK", "MO", "MM", "TH", "LA", "KH", "VN", "MY",
  "SG", "ID", "BN", "PH", "TL", "KZ", "UZ", "TM", "KG", "TJ",
]
const PACIFIC = ["AU", "NZ", "PG", "FJ", "SB", "VU", "WS", "TO", "KI", "TV", "NR", "FM", "MH", "PW"]

/** PRD r4 AC 5 (E1) region table, ISO 3166-1 alpha-2 members. `matchedRegions` and the location rule both read it. */
export const REGION_MEMBERS: Readonly<Record<RegionKey, readonly string[]>> = {
  africa: AU_MEMBERS,
  emea: [...new Set([...EUROPE, ...AU_MEMBERS, ...MIDDLE_EAST])],
  europe: EUROPE,
  eu: EU,
  middle_east: MIDDLE_EAST,
  north_america: ["US", "CA", "MX"],
  americas: ["US", "CA", ...LATAM],
  latam: LATAM,
  apac: [...ASIA, ...PACIFIC],
  asia: ASIA,
  uk: ["GB"],
  us: ["US"],
}

/** Region names a posting may use, folded, longest first within each region. Anything else is not read as a region. */
const REGION_NAMES: ReadonlyArray<readonly [RegionKey, readonly string[]]> = [
  ["emea", ["emea"]],
  ["middle_east", ["middle east", "mena"]],
  ["north_america", ["north america"]],
  ["latam", ["latin america", "latam"]],
  ["americas", ["americas", "america"]],
  ["apac", ["asia-pacific", "asia pacific", "apac"]],
  ["asia", ["asia"]],
  ["eu", ["european union", "eu"]],
  ["europe", ["europe"]],
  ["africa", ["africa"]],
  ["uk", ["uk", "united kingdom"]],
  ["us", ["united states", "usa", "us"]],
]

/** A qualifier before a region name makes it a different area ("Western Europe", "Sub-Saharan Africa"): not read (PRD E1). */
const QUALIFIER = /(?:western|eastern|northern|southern|central|sub-saharan|subsaharan|north|south|east|west|north-west|south-east|south-west|north-east)[\s-]+$/

/** One area a posting names: a region of the table or a catalog country, with its members. */
export type Area = Readonly<{ text: string; index: number; members: readonly string[] }>

/**
 * Areas named in `folded` (lower case), in text order: table regions (not
 * after a qualifier) and catalog countries or cities. "South Africa" is the
 * country, never the region Africa after "south".
 */
export function areasIn(folded: string): Area[] {
  const found: Area[] = []
  const taken: Array<[number, number]> = []
  const claim = (index: number, length: number) => {
    if (taken.some(([start, end]) => index < end && index + length > start)) return false
    taken.push([index, index + length])
    return true
  }
  const scan = (name: string, members: readonly string[], isRegion: boolean) => {
    for (const match of folded.matchAll(new RegExp(`(^|[^a-z])${escapeRegExp(name)}(?=[^a-z]|$)`, "g"))) {
      const index = match.index + match[1]!.length
      if (isRegion && QUALIFIER.test(folded.slice(0, index))) continue
      if (claim(index, name.length)) found.push({ text: name, index, members })
    }
  }
  // Longer names first, so "south africa" is claimed before "africa" and "north america" before "america".
  const entries: Array<[string, readonly string[], boolean]> = [
    ...ALL_PLACES.flatMap((place) => place.names.map((name): [string, readonly string[], boolean] => [name, [place.code], false])),
    ...REGION_NAMES.flatMap(([region, names]) => names.map((name): [string, readonly string[], boolean] => [name, REGION_MEMBERS[region], true])),
  ].sort((a, b) => b[0].length - a[0].length)
  for (const [name, members, isRegion] of entries) scan(name, members, isRegion)
  return found.sort((a, b) => a.index - b.index)
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
